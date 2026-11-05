# Changelog

Each release's notes on GitHub (and in HACS) are its section here. Add the section
before raising the version in `manifest.json`; a release without one lists its
commits instead.

## 1.09

- **Pass attributes have new names, so automations that read them need updating.**
  `rise_direction`, `rise_azimuth` and `rise_elevation` are now `appears_direction`,
  `appears_azimuth` and `appears_elevation`. `set_direction`, `set_azimuth` and
  `set_elevation` are now `disappears_direction`, `disappears_azimuth` and
  `disappears_elevation`. `before_sunset` is now `sun_up`. `appears_time` and
  `disappears_time` are new, `satellites` is now always there, and each entry in the
  `passes` list gains `pass_id` and `bright`. Entity ids stay the same.
- **A pass is named after its brightest satellite**, not the first to appear, so its title,
  magnitude, directions and calendar text all describe the same satellite. A pass that
  read "STARLINK-37806 +7" with Tiangong's magnitude now reads "Tiangong +7". A Starlink
  train with something brighter in it no longer shows as a train.
- **Calendar descriptions start with the best view**, and "At 20:31:02, look toward W: 21°
  above the horizon." now reads "First visible at 20:31:02 toward W, 21° high." The link is
  still the last line. An automation that reads the old text needs updating.
- **CelesTrak's download limit is clearer, and harder to run into.** Its refusal now says that
  it allows one download every two hours and that the integration tries again by itself.
  Removing your last location and adding it back no longer asks CelesTrak again too soon:
  the catalogue stays until another download is allowed. If you remove the integration for
  good during that time, `.storage/satellite_spotter.catalog` stays behind; it holds no
  location, and you can delete it.
- **The cloud forecast** now asks Open-Meteo for the five days that are predicted, not seven.
- **The prediction and entity code is rewritten from published sources.** The Sun's position
  now comes from Meeus 1998. In a test across eight cities the same passes were predicted,
  with times at most a second apart.

## 1.06

- **Calendar descriptions are worded differently**, in every language: "Appears at
  20:31:02 in the W, 21° up." now reads "At 20:31:02, look toward W: 21° above the
  horizon." An automation that reads the old text needs updating. Calendar triggers,
  event titles and event links are unchanged.
- **Google Street View and Mapillary photos are for administrators only.** The street
  view used to send the keys to the browser of anyone who opened it. Now only
  administrators' browsers receive them, and everyone else gets Panoramax's photos only.
- **The notification blueprint** now sends the calendar's directions, in Home Assistant's
  language and without the final link, rather than its own short English message.

## 1.05

- Ready for Home Assistant 2026.11. Its location picker now refuses a latitude beyond
  ±90° and a longitude beyond ±180° itself, so adding or moving a location would no
  longer accept a longitude written 0–360°, or say what is wrong with a latitude in its
  own words. Both work as before, on 2026.11 and on older versions.
- Listed under **Vehicles & transport › Flights**, next to the International Space
  Station integration, and **Weather & alerts › Forecasts** when browsing integrations.

## 1.04

- Home Assistant installs the prediction library from PyPI, as
  [pysatellitespotter](https://pypi.org/project/pysatellitespotter/), rather than from
  GitHub. It is the same code as before, a fork of Willem Vooijs's see-a-satellite with
  its fixes, under its own name, so it never replaces the see-a-satellite that the
  See A Satellite Tonight integration installs.

## 1.03

Satellite Tracker is now **Satellite Spotter**, at
[kedube/ha-satellite-spotter](https://github.com/kedube/ha-satellite-spotter).

- **A new domain**, `satellite_spotter`, so Home Assistant sets it up as a new
  integration. Remove Satellite Tracker, install Satellite Spotter and add your locations
  again, as
  [Moving from Satellite Tracker](https://github.com/kedube/ha-satellite-spotter#moving-from-satellite-tracker)
  describes. Locations with the same names get the same entity ids.
- The page is at `/satellite-spotter`, the globe card is `custom:satellite-spotter-card`,
  and the notification blueprint has a new address to import it from. This once, each
  browser starts afresh with the page's settings, the street view's options and the
  street photos you chose.
- A new logo, with the new name.

## 1.00

The first release of Satellite Tracker: when satellites will be visible to the naked eye
from your home, with James Darpinian's See A Satellite Tonight predictions.

- **Sensors and a calendar** for each location: the next pass, the next bright pass, the
  passes in the next 24 hours, whether a satellite is visible now or a bright one is
  coming, and every pass as a calendar event, as the See A Satellite Tonight integration
  has them.
- **The Satellite Tracker page** in the sidebar: a 3D globe with the night side and city
  lights, every satellite in the catalogue, the pass in gold over your home, where to look,
  and simulations of each pass that fast-forward to it.
- **A street view** of each pass from home: a 360° photo of your street, darkened for the
  night, with the sky of the pass in place of its own, from Panoramax and, with their keys
  in the options, Mapillary and Google Street View (the best photo near home, or the
  service you choose). Where there is no photo, a 3D model of the buildings, trees and
  hills around you, with windows lit as at that hour and street lights glowing over pools
  of light. Under stars, constellations, the Moon and the planets, it shows where
  buildings, trees or hills hide the satellite, and has a "Point your phone at the sky"
  mode.
- **Dashboard cards**: a globe card and a passes card.
- **A notification blueprint** that tells your phone where to look before a bright pass.
- In English, Dutch, French, German, Italian, Polish, Portuguese (Brazil), Spanish and
  Swedish.
