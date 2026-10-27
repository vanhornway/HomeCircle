# Measuring HomeCircle's battery use on a phone

HomeCircle estimates its own battery use in **Settings → This phone →
Diagnostics → Battery use (estimated)**. It counts wake-ups, location fixes,
uploads and message fetches (on mobile data or Wi-Fi), and multiplies each by
a typical cost (`COST_MAH` in `mobile/src/lib/energy.ts`). This guide checks
that estimate against what Android itself measures, over 24 hours.

Target: on battery, HomeCircle should use **at most 5% a day** at every
"Location updates" setting, and **under 10%** even on a long-drive day.

## What you need

- An Android phone with HomeCircle installed and set up (location "Allow all
  the time", battery optimisation off, as the setup check asks).
- A computer with `adb` (Android platform-tools), and USB debugging on the
  phone (Settings → About phone → tap Build number 7 times → Developer
  options → USB debugging).

## 24-hour test

1. Charge the phone to 100%, then unplug it. Unplugging starts the "Since
   unplugged" figure in Diagnostics again.
2. Connect it over USB just long enough to reset Android's battery stats
   (USB charging during the reset doesn't matter), then unplug:

   ```bash
   adb shell dumpsys batterystats --reset
   ```

3. Use the phone normally for 24 hours **without charging it**. Note roughly
   what you did: hours driving, hours on Wi-Fi at home, hours on mobile data.
4. Plug in over USB and save Android's numbers, before charging for long:

   ```bash
   adb shell dumpsys batterystats us.umair.homecircle > homecircle-batterystats.txt
   ```

   ```bash
   adb bugreport homecircle-bugreport.zip
   ```

5. In the batterystats file, find the line starting `Estimated power use
   (mAh)` and the `Uid u0a…` entry for HomeCircle (search for
   `us.umair.homecircle` to find its uid). That's Android's own estimate of
   HomeCircle's share. For a timeline (when the phone woke, GPS and radio
   use), open the bugreport zip in Battery Historian
   (<https://github.com/google/battery-historian>).
6. Compare with **Diagnostics → Battery use (estimated) → Since unplugged**
   in the app, and note both figures with the day's activity.

## Reading the result

- 1% of a 5000 mAh battery is about 50 mAh; the app assumes 5000 mAh.
- If Android's figure is much higher than the app's estimate, the per-event
  costs in `COST_MAH` are too low. The Diagnostics counts show which events
  happened most, so you can see which cost to correct.
- Repeat at the "Most up to date" and "Longest battery" settings. A day with
  a long drive is the hardest case.
