#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "net/wifi_policy.h"

static void credential_boundaries(void) {
  const char *password = "test-password";
  char ssid[34];
  memset(ssid, 's', sizeof(ssid));
  ssid[32] = '\0';
  assert(alfred_wifi_profile_valid(ssid, password));
  ssid[32] = 's';
  ssid[33] = '\0';
  assert(!alfred_wifi_profile_valid(ssid, password));
  assert(!alfred_wifi_profile_valid("", password));
  assert(!alfred_wifi_profile_valid(NULL, password));
  assert(!alfred_wifi_profile_valid("test", NULL));

  // Limits apply to UTF-8 bytes, not displayed character count.
  char utf8_ssid[35];
  for (size_t i = 0; i < 17; ++i) {
    utf8_ssid[2 * i] = (char)0xc3;
    utf8_ssid[2 * i + 1] = (char)0xa9;
  }
  utf8_ssid[32] = '\0';
  assert(alfred_wifi_profile_valid(utf8_ssid, password));
  utf8_ssid[32] = (char)0xc3;
  utf8_ssid[34] = '\0';
  assert(!alfred_wifi_profile_valid(utf8_ssid, password));

  assert(alfred_wifi_profile_valid("synthetic-open", ""));
  assert(!alfred_wifi_profile_valid("synthetic", "1234567"));
  assert(alfred_wifi_profile_valid("synthetic", "12345678"));
  // The radio band cannot be inferred from an SSID's text.
  assert(alfred_wifi_profile_valid("synthetic-5G", password));
  char passphrase[66];
  memset(passphrase, 'z', sizeof(passphrase));
  passphrase[63] = '\0';
  assert(alfred_wifi_profile_valid("synthetic", passphrase));
  passphrase[63] = 'z';
  passphrase[64] = '\0';
  assert(!alfred_wifi_profile_valid("synthetic", passphrase));
  memset(passphrase, 'a', 64);
  assert(alfred_wifi_profile_valid("synthetic", passphrase));
  passphrase[0] = 'F';
  passphrase[63] = '9';
  assert(alfred_wifi_profile_valid("synthetic", passphrase));
  passphrase[31] = 'g';
  assert(!alfred_wifi_profile_valid("synthetic", passphrase));
  memset(passphrase, 'a', 65);
  passphrase[65] = '\0';
  assert(!alfred_wifi_profile_valid("synthetic", passphrase));
  puts("credential byte boundaries and open/PSK validation pass");
}

static void profile_catalog(void) {
  alfred_wifi_profiles_t profiles = {0};
  assert(ALFRED_WIFI_PROFILES_MAX == 6);
  assert(alfred_wifi_profiles_add(&profiles, "primary", "test-primary"));
  assert(!alfred_wifi_profiles_add(&profiles, "primary", "test-primary"));
  assert(!alfred_wifi_profiles_add(&profiles, "", "test-password"));
  assert(!alfred_wifi_profiles_add(&profiles, "invalid", "short"));
  assert(profiles.count == 1);
  assert(strcmp(profiles.items[0].ssid, "primary") == 0);

  // Two locations may deliberately reuse the SSID with different passwords.
  assert(alfred_wifi_profiles_add(&profiles, "primary", "test-secondary"));
  assert(alfred_wifi_profiles_add(&profiles, "fallback-2", "test-password"));
  assert(alfred_wifi_profiles_add(&profiles, "fallback-3", "test-password"));
  assert(alfred_wifi_profiles_add(&profiles, "fallback-4", ""));
  char max_ssid[33], max_psk[65];
  memset(max_ssid, 's', 32);
  max_ssid[32] = '\0';
  memset(max_psk, 'A', 64);
  max_psk[64] = '\0';
  assert(alfred_wifi_profiles_add(&profiles, max_ssid, max_psk));
  assert(profiles.count == 6);
  assert(memcmp(profiles.items[5].ssid, max_ssid, sizeof(max_ssid)) == 0);
  assert(memcmp(profiles.items[5].password, max_psk, sizeof(max_psk)) == 0);
  alfred_wifi_profiles_t before = profiles;
  assert(!alfred_wifi_profiles_add(&profiles, "overflow", "test-password"));
  assert(memcmp(&before, &profiles, sizeof(profiles)) == 0);
  puts("six-profile order, exact-pair deduplication and lossless copies pass");
}

static void repeated_failover(void) {
  assert(ALFRED_WIFI_ATTEMPTS_PER_PROFILE == 2);
  assert(ALFRED_WIFI_RETRY_MS == 2000);
  assert(ALFRED_WIFI_CYCLE_PAUSE_MS == 30000);
  for (size_t count = 1; count <= 6; ++count) {
    alfred_wifi_policy_t policy;
    assert(alfred_wifi_policy_init(&policy, count));
    assert(policy.current == 0);
    // A prolonged outage must keep trying every configured profile; a counter
    // must never strand the device after one unsuccessful pass.
    for (unsigned cycle = 0; cycle < 100; ++cycle) {
      for (size_t slot = 0; slot < count; ++slot) {
        assert(policy.current == slot);
        assert(alfred_wifi_policy_failed(&policy) == 2000);
        assert(policy.current == slot);
        uint32_t wait = alfred_wifi_policy_failed(&policy);
        if (slot + 1 == count) {
          assert(policy.current == 0);
          assert(wait == 30000);
        } else {
          assert(policy.current == slot + 1);
          assert(wait == 2000);
        }
      }
    }
  }
  puts("one through six profiles survive 100 complete outage cycles");
}

static void recovery_and_new_cycle_origin(void) {
  alfred_wifi_policy_t policy;
  assert(alfred_wifi_policy_init(&policy, 6));
  for (unsigned i = 0; i < 4; ++i)
    (void)alfred_wifi_policy_failed(&policy);
  assert(policy.current == 2);
  (void)alfred_wifi_policy_failed(&policy);
  // The second attempt on this fallback succeeds. A later link drop must get
  // its full retry budget instead of immediately rotating away.
  alfred_wifi_policy_connected(&policy);
  assert(policy.connected);
  assert(policy.current == 2);
  assert(alfred_wifi_policy_failed(&policy) == 2000);
  assert(!policy.connected);
  assert(policy.current == 2);
  assert(alfred_wifi_policy_failed(&policy) == 2000);
  assert(policy.current == 3);

  const size_t remaining[] = {3, 4, 5, 0, 1};
  for (size_t i = 0; i < sizeof(remaining) / sizeof(remaining[0]); ++i) {
    assert(policy.current == remaining[i]);
    assert(alfred_wifi_policy_failed(&policy) == 2000);
    uint32_t wait = alfred_wifi_policy_failed(&policy);
    assert(wait == (i == 4 ? 30000 : 2000));
  }
  assert(policy.current == 2);
  alfred_wifi_policy_connected(&policy);
  alfred_wifi_policy_connected(&policy); // Duplicate IP notifications are safe.
  assert(alfred_wifi_policy_failed(&policy) == 2000);
  assert(policy.current == 2);
  puts("successful fallback resets retries and becomes the next cycle origin");
}

static void unusable_catalog(void) {
  alfred_wifi_policy_t policy = {0};
  assert(!alfred_wifi_policy_init(&policy, 0));
  assert(alfred_wifi_policy_failed(&policy) == 0);
  assert(!alfred_wifi_policy_init(&policy, 7));
  puts("empty and out-of-capacity profile counts are rejected");
}

int main(void) {
  credential_boundaries();
  profile_catalog();
  repeated_failover();
  recovery_and_new_cycle_origin();
  unusable_catalog();
  puts("Wi-Fi fallback policy regressions pass");
  return 0;
}
