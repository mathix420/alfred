// SPDX-License-Identifier: MIT
#include "net/wifi_policy.h"

#include <string.h>

bool alfred_wifi_profile_valid(const char *ssid, const char *password) {
  if (!ssid || !password)
    return false;
  size_t ssid_len = strnlen(ssid, 33);
  size_t password_len = strnlen(password, 65);
  if (!ssid_len || ssid_len > 32)
    return false;
  if (!password_len || (password_len >= 8 && password_len <= 63))
    return true;
  if (password_len != 64)
    return false;
  for (size_t i = 0; i < password_len; ++i) {
    unsigned char c = (unsigned char)password[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
          (c >= 'A' && c <= 'F')))
      return false;
  }
  return true;
}

bool alfred_wifi_profiles_add(alfred_wifi_profiles_t *profiles,
                              const char *ssid, const char *password) {
  if (!profiles || profiles->count >= ALFRED_WIFI_PROFILES_MAX ||
      !alfred_wifi_profile_valid(ssid, password))
    return false;
  for (size_t i = 0; i < profiles->count; ++i)
    if (!strcmp(profiles->items[i].ssid, ssid) &&
        !strcmp(profiles->items[i].password, password))
      return false;
  alfred_wifi_profile_t *profile = &profiles->items[profiles->count++];
  memcpy(profile->ssid, ssid, strlen(ssid) + 1);
  memcpy(profile->password, password, strlen(password) + 1);
  return true;
}

bool alfred_wifi_policy_init(alfred_wifi_policy_t *policy, size_t count) {
  if (!policy)
    return false;
  memset(policy, 0, sizeof(*policy));
  if (!count || count > ALFRED_WIFI_PROFILES_MAX)
    return false;
  policy->count = count;
  return true;
}

void alfred_wifi_policy_connected(alfred_wifi_policy_t *policy) {
  policy->connected = true;
  policy->failures = 0;
  policy->cycle_start = policy->current;
}

uint32_t alfred_wifi_policy_failed(alfred_wifi_policy_t *policy) {
  if (!policy->count)
    return 0;
  policy->connected = false;
  if (++policy->failures < ALFRED_WIFI_ATTEMPTS_PER_PROFILE)
    return ALFRED_WIFI_RETRY_MS;
  policy->failures = 0;
  policy->current = (policy->current + 1) % policy->count;
  return policy->current == policy->cycle_start ? ALFRED_WIFI_CYCLE_PAUSE_MS
                                                : ALFRED_WIFI_RETRY_MS;
}
