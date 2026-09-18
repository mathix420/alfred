type Category = "work" | "health" | "personal";
interface TaskCategory {
  id: string;
  title: string;
  color: string;
}
interface Task {
  id: string;
  title: string;
  category: Category;
  categoryId?: string;
  memo: string;
  dueAt: string | null;
  completed: boolean;
}
interface Snapshot {
  tasks: Task[];
  categories?: TaskCategory[];
  focusId: string | null;
  revision: number;
  mode: "demo" | "live";
  connection: "online" | "offline" | "unconfigured";
}
type View = "focus" | "today" | "memo" | "listening" | "thinking" | "sent";
const screen = document.querySelector<HTMLElement>("#screen")!;
const announcement = document.querySelector<HTMLElement>("#announcement")!;
const flowerPath =
  "M2 32a30 30 0 1 0 60 0 30 30 0 1 0-60 0m36 0a30 30 0 1 0 60 0 30 30 0 1 0-60 0m-36 36a30 30 0 1 0 60 0 30 30 0 1 0-60 0m36 0a30 30 0 1 0 60 0 30 30 0 1 0-60 0z";
const sparklePath = "M50 0c6 34 16 44 50 50-34 6-44 16-50 50-6-34-16-44-50-50 34-6 44-16 50-50z";
const icons: Record<string, string> = {
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 10v4M6 10v4m4-4v4"/>',
  retry: '<path d="M20 7v5h-5M4 17v-5h5M6.3 6.3a8 8 0 0 1 13.2 3.3M4.5 14.4a8 8 0 0 0 13.2 3.3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h8"/>',
  offline:
    '<path d="m2 2 20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.6m5 .2a10 10 0 0 1 4 2.4M2 9a16 16 0 0 1 4-2.5m4-1a16 16 0 0 1 12 3.5M12 20h.01"/>',
};
function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
function icon(name: string, cls = ""): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? ""}</svg>`;
}
function flower(cls = "", path = flowerPath): string {
  return `<svg class="flower ${cls}" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
}
function tick(cls = "checkmark"): string {
  return `<svg class="${cls}" viewBox="0 0 58 58" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 30 9 9 20-21"/></svg>`;
}
let snapshot: Snapshot | null = null;
let view: View = "focus";
let socket: WebSocket | null = null;
let online = false;
let voiceStatus = "";
let memoId: string | null = null;
let toast = "";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let completion: { task: Task; requestId: string; phase: "waiting" | "celebrating" } | null = null;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let completionTimeout: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 800;
let voiceHeld = false;
let voiceEpoch = 0;
let microphone: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let captureModuleReady: Promise<void> | null = null;
let acceptNextSnapshot = false;
let worklet: AudioWorkletNode | null = null;
let requestTimeoutMs = 190000;
const deviceId = `browser-${getBrowserId()}`;
let deviceToken = "";
let needsToken = false;
const accessDialog = document.querySelector<HTMLDialogElement>("#access-dialog")!;
function requestToken(): void {
  const wasWaiting = needsToken;
  needsToken = true;
  clearTimeout(reconnectTimer);
  online = false;
  socket?.close();
  if (!accessDialog.open) accessDialog.showModal();
  if (!wasWaiting && deviceToken)
    document.querySelector("#access-error")!.textContent = "That token wasn't accepted. Try again.";
}
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (deviceToken) headers.set("Authorization", `Bearer ${deviceToken}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) requestToken();
  return response;
}
accessDialog.addEventListener("cancel", (event) => event.preventDefault());
document.querySelector("#access-form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector<HTMLInputElement>("#device-token")!;
  deviceToken = input.value.trim();
  if (!deviceToken) return;
  input.value = "";
  needsToken = false;
  document.querySelector("#access-error")!.textContent = "";
  accessDialog.close();
  void refresh();
  void loadStatus();
  socket?.close();
  socket = null;
  connect();
});
function getBrowserId(): string {
  try {
    const existing = sessionStorage.getItem("alfred-device-id");
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem("alfred-device-id", id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
function currentTask(): Task | undefined {
  return snapshot?.tasks.find((task) => task.id === snapshot?.focusId && !task.completed);
}
function send(message: object): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}
function notice(message: string): void {
  toast = message;
  announcement.textContent = message;
  clearTimeout(toastTimer);
  render();
  toastTimer = setTimeout(() => {
    toast = "";
    render();
  }, 3400);
}
const legacyCategories: TaskCategory[] = [
  { id: "work", title: "Work", color: "#a78bfa" },
  { id: "health", title: "Health", color: "#35d97f" },
  { id: "personal", title: "Personal", color: "#8b9cea" },
];
function taskCategory(task: Task): TaskCategory {
  return (
    snapshot?.categories?.find((item) => item.id === (task.categoryId ?? task.category)) ??
    legacyCategories.find((item) => item.id === task.category) ??
    legacyCategories[2]!
  );
}
function categoryAttributes(group: TaskCategory): string {
  const color = /^#[0-9a-f]{6}$/i.test(group.color) ? group.color : "#8b9cea";
  return `data-category="${escape(group.id)}" style="--category-color:${color}"`;
}
function category(group: TaskCategory): string {
  return `<span class="category" title="${escape(group.title)}">${flower()}<span class="category-label">${escape(group.title)}</span></span>`;
}
function dueLabel(task: Task, short = false): string {
  if (!task.dueAt) return "";
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return "";
  const time = due.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (short) return time;
  return `${due.toDateString() === new Date().toDateString() ? "Today" : due.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
function status(): string {
  const demo = snapshot?.mode === "demo";
  const connected = online && snapshot?.connection !== "offline";
  const time = new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });
  return `<div class="status"><span class="clock-time">${time}</span><div class="indicators">${demo ? '<span class="demo-label">DEMO</span>' : ""}<span class="link-dot ${!connected ? "offline" : demo ? "demo" : ""}" role="img" aria-label="${demo ? "Demo mode" : connected ? "Connected to Alfred" : "Offline"}"></span>${icon("battery", "battery")}</div></div>`;
}
function hint(label = "Hold to talk", action = "voice", mic = true): string {
  return `<button class="hint" data-${action} aria-label="${escape(label)}">${mic ? icon("mic") : ""}<span>${escape(label)}</span></button>`;
}
function check(): string {
  return `<div class="check-wrap">${flower("check-flower")}${tick()}<span class="pop-ring"></span>${[0, 1, 2, 3, 4, 5].map((i) => flower(`confetti c${i}`, i === 5 ? sparklePath : flowerPath)).join("")}</div>`;
}
function focusView(): string {
  const task = completion?.task ?? currentTask();
  if (
    !snapshot ||
    ((!online || snapshot.connection === "offline") && snapshot.mode !== "demo" && !task)
  )
    return offlineView();
  if (!task)
    return `<div class="page">${status()}<div class="empty-body"><div class="check-wrap">${flower("check-flower")}<svg class="sleepy-eyes" viewBox="0 0 54 16" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M2 5q7 8 14 0M34 5q7 8 14 0"/></svg><span class="sleep-z">z</span><span class="sleep-z small">z</span></div><p>${snapshot.mode === "live" && !snapshot.tasks.length ? "Nothing to focus on." : "Good job, enjoy the calm."}</p></div>${hint()}<button class="grabber" data-today aria-label="Open today"></button></div>`;
  const due = dueLabel(task);
  const phase = completion?.phase ?? "";
  const group = taskCategory(task);
  return `<div class="page ${phase}" data-view="focus" ${categoryAttributes(group)}>${status()}<button class="focus-body" data-complete="${escape(task.id)}" aria-label="Complete task: ${escape(task.title)}" ${completion ? "disabled" : ""}><span class="category-row">${category(group)}${due ? `<span class="due">${icon("clock")}${escape(due)}</span>` : ""}</span>${check()}<span class="task-title ${task.title.length > 65 ? "long" : ""}">${escape(task.title)}</span></button>${phase === "celebrating" ? '<div class="hint success">Nice.</div>' : phase === "waiting" ? '<div class="hint">Saving…</div>' : hint()}<button class="grabber" data-today aria-label="Open today"></button></div>`;
}
function todayView(): string {
  if (!snapshot) return offlineView();
  const groups = snapshot.categories ?? legacyCategories;
  return `<div class="page list-page"><button class="grabber top" data-back aria-label="Return to focus"></button>${status()}<div class="list-heading"><button class="back-title" data-back aria-label="Today, return to focus">Today</button><div class="count">${flower()}${snapshot.tasks.filter((t) => t.completed).length}/${snapshot.tasks.length}</div></div><div class="scroll-area" data-scroll>${groups
    .map((group) => {
      const tasks = snapshot!.tasks.filter((t) => (t.categoryId ?? t.category) === group.id);
      if (!tasks.length) return "";
      return `<div class="task-section" ${categoryAttributes(group)}>${category(group)}${tasks.map((task) => `<button class="task-row ${task.id === snapshot?.focusId ? "current" : ""}" data-task="${escape(task.id)}" aria-label="${task.completed ? "Completed: " : "Open memo: "}${escape(task.title)}"><span class="row-check ${task.completed ? "done" : ""}">${flower()}${task.completed ? tick("row-tick") : ""}</span><span class="row-content"><span class="row-label">${escape(task.title)}</span>${task.dueAt && task.id !== snapshot?.focusId ? `<span class="row-due">${icon("clock")}${escape(dueLabel(task, true))}</span>` : ""}</span>${task.id === snapshot?.focusId ? '<span class="now-tag">now</span>' : ""}</button>`).join("")}</div>`;
    })
    .join("")}</div></div>`;
}
function memoView(): string {
  const task = snapshot?.tasks.find((t) => t.id === memoId) ?? currentTask();
  return `<div class="page memo-page"><button class="grabber top" data-back aria-label="Return to focus"></button>${status()}<div class="memo-body"><button class="memo-heading" data-back aria-label="Memo, return to focus"><span class="memo-badge">${icon("file")}</span>Memo</button><article class="memo-article scroll-area" data-scroll tabindex="0" aria-label="Task memo">${escape(task?.memo || "No memo for this task yet. Ask Hermes to add one.")}</article></div><div class="memo-fade"></div></div>`;
}
function voiceView(): string {
  if (view === "sent")
    return `<div class="page sent">${status()}<div class="voice-center">${check()}<h1 class="voice-label">Sent!</h1></div><div class="hint"></div></div>`;
  const listening = view === "listening";
  return `<div class="page ${listening ? "listening" : "thinking"}">${status()}<div class="voice-center">${listening ? `<div class="waveform">${[26, 58, 88, 44, 30].map((height, i) => `<i style="--bar:${height}px;--delay:${i * -0.14}s"></i>`).join("")}</div>` : `<div class="thinking-dots">${flower()}${flower()}${flower()}</div>`}<h1 class="voice-label">${listening ? '<span class="live-dot"></span>' : ""}${listening ? "Listening" : "Sending"}</h1><p class="voice-detail">${escape(voiceStatus || (snapshot?.mode === "demo" ? "Demo recording" : listening ? "Hold while you speak." : "Uploading your voice message…"))}</p></div>${hint(listening ? "Release to send" : "Tap to cancel", listening ? "noop" : "cancel", false)}</div>`;
}
function offlineView(): string {
  return `<div class="page">${status()}<div class="offline-body"><div class="check-wrap">${flower("check-flower")}${icon("offline", "offline-icon")}</div><h1 class="task-title">No connection</h1><p class="offline-description">Can't reach the server. Alfred will reconnect on its own.</p></div><button class="hint" data-retry>${icon("retry")}Tap to retry</button></div>`;
}
function pageMarkup(page: View): string {
  return page === "focus"
    ? focusView()
    : page === "today"
      ? todayView()
      : page === "memo"
        ? memoView()
        : voiceView();
}
type PageMotion = {
  from: View;
  to: View;
  outgoing: HTMLElement;
  incoming: HTMLElement;
  direction: number;
  offset: number;
  animations: Animation[];
  settling: boolean;
};
let motion: PageMotion | null = null;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
function readingEdge(): void {
  const article = screen.querySelector<HTMLElement>(".memo-article");
  if (article)
    article
      .closest(".memo-page")
      ?.classList.toggle(
        "at-end",
        article.scrollHeight - article.clientHeight - article.scrollTop < 2,
      );
}
screen.addEventListener("scroll", readingEdge, true);
function render(): void {
  if (motion) {
    if (view === motion.from || view === motion.to) return;
    for (const animation of motion.animations) animation.cancel();
    motion = null;
  }
  const scroll = screen.querySelector<HTMLElement>("[data-scroll]");
  const offset = scroll?.scrollTop ?? 0;
  const oldView = screen.dataset.view;
  screen.dataset.view = view;
  screen.innerHTML = pageMarkup(view);
  if (oldView === view && offset) screen.querySelector("[data-scroll]")?.scrollTo(0, offset);
  readingEdge();
  if (toast) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = toast;
    screen.append(el);
  }
  document.querySelector("#mode-label")!.textContent =
    snapshot?.mode === "demo" ? "Interactive demo" : online ? "Connected to Alfred" : "Offline";
  document.querySelector("#connection-note")!.textContent =
    snapshot?.mode === "demo"
      ? "Demo tasks · cloud credentials are not configured. Tap a task to try the completion animation."
      : "Tap to complete · side buttons to talk or go back.";
}
function adopt(next: Snapshot): void {
  if (!next || !Array.isArray(next.tasks) || typeof next.revision !== "number") return;
  if (!acceptNextSnapshot && snapshot && next.revision < snapshot.revision) return;
  acceptNextSnapshot = false;
  snapshot = next;
  if (!completion) render();
}
async function refresh(): Promise<void> {
  try {
    const response = await apiFetch("/api/focus", { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Unavailable");
    adopt((await response.json()) as Snapshot);
  } catch {
    if (!snapshot) render();
  }
}
function connect(): void {
  clearTimeout(reconnectTimer);
  if (needsToken) return;
  if (socket && socket.readyState < WebSocket.CLOSING) return;
  const ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  );
  socket = ws;
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    online = true;
    reconnectDelay = 800;
    send({ type: "hello", protocol: 2, deviceId, ...(deviceToken ? { token: deviceToken } : {}) });
    render();
  };
  ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
    if (event.data instanceof ArrayBuffer) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case "hello":
        acceptNextSnapshot = true;
        break;
      case "focus":
        adopt(message.snapshot as Snapshot);
        break;
      case "task_completed":
        if (!completion || completion.requestId !== message.requestId) break;
        clearTimeout(completionTimeout);
        completion.phase = "celebrating";
        announcement.textContent = `Completed: ${completion.task.title}`;
        render();
        completionTimer = setTimeout(() => {
          completion = null;
          view = "focus";
          render();
          void refresh();
        }, 950);
        break;
      case "state":
        if (message.state === "idle") {
          if (!voiceHeld) {
            view = "focus";
            render();
          }
        } else if (["listening", "thinking", "sent"].includes(String(message.state))) {
          if (completion) break;
          view = message.state as View;
          render();
        }
        break;
      case "voice_job": {
        const job = message.job as { state?: string } | undefined;
        if (job && view === "thinking") {
          if (job.state === "queued" || job.state === "sending") voiceStatus = "Sending to Beeper…";
          render();
        }
        break;
      }
      case "error":
        if (String(message.code).toLowerCase().includes("auth")) {
          requestToken();
          break;
        }
        if (!message.requestId || message.requestId === completion?.requestId) {
          clearTimeout(completionTimeout);
          clearTimeout(completionTimer);
          completion = null;
          stopCapture();
          voiceHeld = false;
          view = "focus";
          notice(
            typeof message.message === "string"
              ? message.message
              : "Something went wrong. Please try again.",
          );
        }
        break;
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    online = false;
    socket = null;
    stopCapture();
    voiceHeld = false;
    if (["listening", "thinking", "sent"].includes(view)) view = "focus";
    if (completion?.phase === "waiting") {
      completion = null;
      clearTimeout(completionTimeout);
    }
    render();
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.7, 12000);
  };
  ws.onerror = () => ws.close();
}
function complete(id?: string): void {
  if (completion || view !== "focus") return;
  const task = currentTask();
  if (!task || (id && id !== task.id)) return;
  if (!online || snapshot?.connection === "offline") {
    notice("You're offline. Reconnect to save this task.");
    connect();
    return;
  }
  const requestId = crypto.randomUUID();
  completion = { task: { ...task }, requestId, phase: "waiting" };
  if (!send({ type: "complete_task", id: task.id, requestId })) {
    completion = null;
    notice("Reconnecting. Please try again.");
    return;
  }
  render();
  completionTimeout = setTimeout(() => {
    if (completion?.requestId !== requestId || completion.phase !== "waiting") return;
    completion = null;
    notice("Still waiting for confirmation. Refreshing your tasks…");
    void refresh();
  }, requestTimeoutMs);
}
function beginMotion(next: View, direction: number, taskId?: string): PageMotion | null {
  if (motion || completion || voiceHeld || view === next) return null;
  if (next === "memo") memoId = taskId ?? currentTask()?.id ?? null;
  const outgoing = screen.querySelector<HTMLElement>(".page");
  if (!outgoing) return null;
  const template = document.createElement("template");
  template.innerHTML = pageMarkup(next);
  const incoming = template.content.firstElementChild as HTMLElement;
  incoming.inert = true;
  outgoing.classList.remove("pressed");
  screen.append(incoming);
  motion = {
    from: view,
    to: next,
    outgoing,
    incoming,
    direction,
    offset: 0,
    animations: [],
    settling: false,
  };
  positionMotion(0);
  return motion;
}
function positionMotion(offset: number): void {
  if (!motion) return;
  motion.offset = offset;
  motion.outgoing.style.transform = `translate3d(0,${offset}px,0)`;
  motion.incoming.style.transform = `translate3d(0,${offset - motion.direction * screen.clientHeight}px,0)`;
}
function settleMotion(commit: boolean): void {
  const active = motion;
  if (!active || active.settling) return;
  active.settling = true;
  const height = screen.clientHeight;
  const end = commit ? active.direction * height : 0;
  if (commit) {
    view = active.to;
    screen.dataset.view = view;
  }
  const options: KeyframeAnimationOptions = {
    duration: reducedMotion.matches
      ? 0
      : commit
        ? Math.max(110, 240 * (1 - Math.abs(active.offset) / height) ** 0.4)
        : 180,
    easing: "cubic-bezier(.22,.8,.25,1)",
    fill: "forwards",
  };
  active.animations = [
    active.outgoing.animate(
      [
        { transform: `translate3d(0,${active.offset}px,0)` },
        { transform: `translate3d(0,${end}px,0)` },
      ],
      options,
    ),
    active.incoming.animate(
      [
        { transform: `translate3d(0,${active.offset - active.direction * height}px,0)` },
        { transform: `translate3d(0,${end - active.direction * height}px,0)` },
      ],
      options,
    ),
  ];
  void Promise.all(active.animations.map((animation) => animation.finished))
    .then(() => {
      if (motion !== active) return;
      const keep = commit ? active.incoming : active.outgoing;
      (commit ? active.outgoing : active.incoming).remove();
      for (const animation of active.animations) animation.cancel();
      keep.style.transform = "";
      keep.inert = false;
      motion = null;
      render();
    })
    .catch(() => undefined);
}
function navigate(next: View, taskId?: string): void {
  const direction = next === "today" || (next === "focus" && view === "memo") ? -1 : 1;
  if (beginMotion(next, direction, taskId)) settleMotion(true);
}
function cancel(): void {
  voiceEpoch++;
  voiceHeld = false;
  stopCapture();
  send({ type: "cancel" });
  voiceStatus = "";
  view = "focus";
  render();
}
function stopCapture(): void {
  microphone?.getTracks().forEach((track) => track.stop());
  microphone = null;
  worklet?.disconnect();
  worklet = null;
}
async function startVoice(): Promise<void> {
  if (voiceHeld || completion) return;
  if (!online) {
    notice("Connect to Alfred to talk.");
    return;
  }
  if (["thinking", "sent"].includes(view)) cancel();
  voiceHeld = true;
  const epoch = ++voiceEpoch;
  voiceStatus = "";
  if (snapshot?.mode === "demo") {
    send({ type: "ptt_down", sampleRate: 16000, channels: 1 });
    view = "listening";
    render();
    return;
  }
  try {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Microphone requires HTTPS or localhost.");
    audioContext ??= new AudioContext({ sampleRate: 16000 });
    await audioContext.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
    });
    if (!voiceHeld || epoch !== voiceEpoch) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    microphone = stream;
    if (!captureModuleReady) {
      const module = new Blob(
        [
          `class Capture extends AudioWorkletProcessor { process(inputs) { const samples=inputs[0]?.[0]; if(samples)this.port.postMessage(samples); return true; } } registerProcessor('alfred-capture',Capture);`,
        ],
        { type: "text/javascript" },
      );
      const url = URL.createObjectURL(module);
      captureModuleReady = audioContext.audioWorklet
        .addModule(url)
        .catch((error: unknown) => {
          captureModuleReady = null;
          throw error;
        })
        .finally(() => URL.revokeObjectURL(url));
    }
    await captureModuleReady;
    if (!voiceHeld || epoch !== voiceEpoch) {
      stopCapture();
      return;
    }
    worklet = new AudioWorkletNode(audioContext, "alfred-capture");
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!voiceHeld || epoch !== voiceEpoch || socket?.readyState !== WebSocket.OPEN) return;
      const samples = event.data;
      const rate = audioContext!.sampleRate / 16000;
      const pcm = new Int16Array(Math.floor(samples.length / rate));
      for (let i = 0; i < pcm.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[Math.floor(i * rate)] ?? 0));
        pcm[i] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      }
      socket.send(pcm.buffer);
    };
    const source = audioContext.createMediaStreamSource(stream);
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(audioContext.destination);
    send({ type: "ptt_down", sampleRate: 16000, channels: 1 });
    view = "listening";
    render();
  } catch (error) {
    stopCapture();
    voiceHeld = false;
    view = "focus";
    notice(
      error instanceof Error && error.message.includes("HTTPS")
        ? error.message
        : "Microphone unavailable. Check your browser permission.",
    );
  }
}
function finishVoice(): void {
  if (!voiceHeld) return;
  voiceHeld = false;
  voiceEpoch++;
  stopCapture();
  if (view === "listening") {
    send({ type: "ptt_up" });
    view = "thinking";
    render();
  }
}
let gesture: {
  x: number;
  y: number;
  time: number;
  lastY: number;
  lastTime: number;
  velocity: number;
  scroll: HTMLElement | null;
  voice: boolean;
  pointerId: number;
} | null = null;
let suppressClick = false;
screen.addEventListener("pointerdown", (event) => {
  if (motion || event.button !== 0) return;
  const target = event.target as HTMLElement;
  const voice = Boolean(target.closest("[data-voice]"));
  gesture = {
    x: event.clientX,
    y: event.clientY,
    time: event.timeStamp,
    lastY: event.clientY,
    lastTime: event.timeStamp,
    velocity: 0,
    scroll: target.closest<HTMLElement>("[data-scroll]"),
    voice,
    pointerId: event.pointerId,
  };
  if (voice) {
    event.preventDefault();
    screen.setPointerCapture(event.pointerId);
    void startVoice();
  } else if (view === "focus" && !completion)
    screen.querySelector(".page")?.classList.add("pressed");
});
screen.addEventListener("pointermove", (event) => {
  const start = gesture;
  // Native browser scrolling owns content gestures; header drags own navigation.
  if (!start || start.voice || start.scroll || completion) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  const elapsed = event.timeStamp - start.lastTime;
  if (elapsed > 0) start.velocity = (event.clientY - start.lastY) / elapsed;
  start.lastY = event.clientY;
  start.lastTime = event.timeStamp;
  if (!motion && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) * 1.2) {
    const next =
      view === "focus"
        ? dy < 0
          ? "today"
          : "memo"
        : (view === "today" && dy > 0) || (view === "memo" && dy < 0)
          ? "focus"
          : null;
    if (next && beginMotion(next, Math.sign(dy))) screen.setPointerCapture(event.pointerId);
  }
  if (motion && !motion.settling) {
    event.preventDefault();
    positionMotion(
      motion.direction * Math.min(screen.clientHeight, Math.max(0, dy * motion.direction)),
    );
  }
});
screen.addEventListener("pointerup", (event) => {
  const start = gesture;
  gesture = null;
  screen.querySelector(".page")?.classList.remove("pressed");
  if (!start) return;
  if (start.voice) {
    suppressNextClick();
    finishVoice();
    return;
  }
  if (motion && !motion.settling) {
    suppressNextClick();
    const recentVelocity = event.timeStamp - start.lastTime < 90 ? start.velocity : 0;
    settleMotion(
      Math.abs(motion.offset) > screen.clientHeight * 0.18 ||
        (Math.abs(motion.offset) > 20 && recentVelocity * motion.direction > 0.45),
    );
    return;
  }
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) suppressNextClick();
});
screen.addEventListener("pointercancel", () => {
  gesture = null;
  screen.querySelector(".page")?.classList.remove("pressed");
  if (motion && !motion.settling) settleMotion(false);
  if (voiceHeld) cancel();
});
function suppressNextClick(): void {
  suppressClick = true;
  setTimeout(() => {
    suppressClick = false;
  }, 100);
}
screen.addEventListener("click", (event) => {
  if (suppressClick || motion) return;
  const target = event.target as HTMLElement;
  if (target.closest("[data-back]")) navigate("focus");
  else if (target.closest("[data-today]")) navigate("today");
  else if (target.closest("[data-cancel]")) cancel();
  else if (target.closest("[data-retry]")) {
    connect();
    send({ type: "refresh" });
    void refresh();
  } else if (target.closest("[data-voice],[data-noop]")) return;
  else if (view === "thinking" || view === "sent") cancel();
  else {
    const task = target.closest<HTMLElement>("[data-task]");
    if (task?.dataset.task) navigate("memo", task.dataset.task);
    else if (view === "focus" && target.closest("[data-complete]")) complete();
  }
});
let wheelLocked = false;
screen.addEventListener(
  "wheel",
  (event) => {
    if (view !== "focus" || Math.abs(event.deltaY) < 8) return;
    event.preventDefault();
    if (wheelLocked) return;
    wheelLocked = true;
    navigate(event.deltaY > 0 ? "today" : "memo");
    setTimeout(() => {
      wheelLocked = false;
    }, 400);
  },
  { passive: false },
);
const talkButton = document.querySelector<HTMLButtonElement>("#talk-button")!;
talkButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  talkButton.setPointerCapture(event.pointerId);
  talkButton.classList.add("held");
  void startVoice();
});
talkButton.addEventListener("pointerup", () => {
  talkButton.classList.remove("held");
  finishVoice();
});
talkButton.addEventListener("pointercancel", () => {
  talkButton.classList.remove("held");
  cancel();
});
document.querySelector("#action-button")!.addEventListener("click", () => {
  if (view === "focus") navigate("today");
  else if (["listening", "thinking", "sent"].includes(view)) cancel();
  else navigate("focus");
});
document.addEventListener("keydown", (event) => {
  if (accessDialog.open || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === "Space") {
    event.preventDefault();
    void startVoice();
  } else if (event.key === "Escape") {
    if (["listening", "thinking", "sent"].includes(view)) cancel();
    else navigate("focus");
  } else if (event.key === "ArrowUp" && view === "focus") {
    event.preventDefault();
    navigate("today");
  } else if (event.key === "ArrowDown" && view === "focus") {
    event.preventDefault();
    navigate("memo");
  } else if (
    event.key === "Enter" &&
    (document.activeElement === document.body || document.activeElement === screen)
  )
    complete();
});
document.addEventListener("keyup", (event) => {
  if (accessDialog.open) return;
  if (event.code === "Space") {
    event.preventDefault();
    finishVoice();
  }
});
window.addEventListener("blur", () => {
  if (voiceHeld) cancel();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && voiceHeld) cancel();
  else if (!document.hidden) {
    connect();
    void refresh();
  }
});
setInterval(() => {
  const time = screen.querySelector(".clock-time");
  if (time)
    time.textContent = new Date().toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
}, 1000);
render();
connect();
void refresh();
async function loadStatus(): Promise<void> {
  try {
    const response = await apiFetch("/api/status");
    if (!response.ok) return;
    const status = (await response.json()) as { requestTimeoutMs?: number };
    if (typeof status.requestTimeoutMs === "number")
      requestTimeoutMs = status.requestTimeoutMs + 10000;
  } catch {
    /* reconnect refresh handles unavailable bridge */
  }
}
void loadStatus();
