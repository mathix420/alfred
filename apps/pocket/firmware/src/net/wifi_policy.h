// SPDX-License-Identifier: MIT
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ALFRED_WIFI_PROFILES_MAX 6
#define ALFRED_WIFI_ATTEMPTS_PER_PROFILE 2
#define ALFRED_WIFI_RETRY_MS 2000
#define ALFRED_WIFI_CYCLE_PAUSE_MS 30000

typedef struct {
  char ssid[33];
  char password[65];
} alfred_wifi_profile_t;

typedef struct {
  alfred_wifi_profile_t items[ALFRED_WIFI_PROFILES_MAX];
  size_t count;
} alfred_wifi_profiles_t;

// Lengths are bytes. Empty passwords explicitly select an open network.
bool alfred_wifi_profile_valid(const char *ssid, const char *password);
// Keeps insertion order; returns false for invalid, duplicate, or full input.
bool alfred_wifi_profiles_add(alfred_wifi_profiles_t *profiles,
                              const char *ssid, const char *password);

typedef struct {
  size_t count, current, cycle_start;
  unsigned failures;
  bool connected;
} alfred_wifi_policy_t;

bool alfred_wifi_policy_init(alfred_wifi_policy_t *policy, size_t count);
void alfred_wifi_policy_connected(alfred_wifi_policy_t *policy);
// Call once per failed attempt/link loss. Returns delay before the next
// attempt. A healthy connection never triggers this policy or changes the
// current index.
uint32_t alfred_wifi_policy_failed(alfred_wifi_policy_t *policy);
