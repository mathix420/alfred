// SPDX-License-Identifier: MIT
#pragma once

// -----------------------------------------------------------------------------
// audio.h — ES8311 codec over I2S: PTT mic capture + TTS playback.
//
// The device is push-to-talk only (SCOPE.md §4). The codec ADC/PGA streams
// ONLY between audio_record_start() and audio_record_stop(), which main.c gates
// on the BOOT/touch PTT button. The physical mic supply remains board-wired.
// Captured frames are pushed to a caller-supplied
// callback (ws_client.c forwards them as binary WebSocket frames between the
// ptt_down/ptt_up control frames). TTS playback runs between the bridge's
// tts_begin/tts_end frames via audio_play_pcm().
//
// Wire-format note: capture is 16 kHz mono S16LE; TTS arrives in the format the
// bridge announced in tts_begin (see alfred_audio_format_t). This implementation
// accepts PCM S16LE mono and rejects Opus/stereo.
// -----------------------------------------------------------------------------

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "net/protocol.h"  // alfred_audio_format_t

#ifdef __cplusplus
extern "C" {
#endif

// Mic capture defaults (one utterance per PTT press → Whisper on the bridge).
#define ALFRED_MIC_SAMPLE_RATE 16000
#define ALFRED_MIC_CHANNELS 1
#define ALFRED_MIC_BITS_PER_SAMPLE 16

// I2S DMA frame chunk pushed per mic callback (samples). ~20 ms @16 kHz.
#define ALFRED_MIC_FRAME_SAMPLES 320

// Called for each captured mic chunk while recording. `pcm` is S16LE,
// ALFRED_MIC_CHANNELS-interleaved; `len` is bytes. Runs on the audio task —
// keep it short (enqueue/transmit, do not block). `user` is the cookie passed
// to audio_record_start().
typedef void (*alfred_mic_cb_t)(const uint8_t *pcm, size_t len, void *user);

// One-time bring-up: configure I2S, reset + init the ES8311 codec, allocate the
// playback ring buffer. Idempotent; safe to call once from board/app init.
esp_err_t audio_init(void);

// -------- mic capture (PTT) --------

// Begin streaming mic frames to `cb`. No-op (returns ESP_OK) if already
// recording. Enables the codec ADC + mic bias.
esp_err_t audio_record_start(alfred_mic_cb_t cb, void *user);

// Stop streaming and quiesce the ADC/mic. No-op if not recording.
esp_err_t audio_record_stop(void);

// True while a capture session is active (codec ADC/PGA powered).
bool audio_is_recording(void);

// -------- TTS playback --------

// Prepare mono PCM S16LE playback for an utterance announced by tts_begin. Configures the
// I2S clock for `fmt`, unmutes the speaker, and resets the playback buffer.
// Call once per tts_begin before the first audio_play_pcm().
esp_err_t audio_play_begin(const alfred_audio_format_t *fmt);

// Queue a decoded PCM chunk for playback (S16LE in the format from
// audio_play_begin). Blocks briefly if the ring buffer is full, up to
// `timeout_ms`. Safe to call repeatedly as binary frames arrive.
esp_err_t audio_play_pcm(const uint8_t *pcm, size_t len, uint32_t timeout_ms);

// Drain queued audio, then mute the speaker. Call on tts_end.
esp_err_t audio_play_end(void);

// Discard queued audio immediately and mute (barge-in or disconnect).
esp_err_t audio_play_cancel(void);

// True while a TTS utterance is being played out.
bool audio_is_playing(void);

#ifdef __cplusplus
}
#endif
