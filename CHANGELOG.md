# Changelog

Each release's notes on GitHub (and in HACS) are its section here. Add the section
before raising the version in `manifest.json`; a release without one lists its
commits instead.

## 1.10

- **Starlink trains are trains again.** 1.09 stopped showing one as a train when something
  brighter flew with it, and **Hide Starlink** stopped hiding it. A pass now counts as a
  train when more than five Starlinks fly together, whichever satellite it is named after,
  and the page says what outshines them, as in "with CZ-2C R/B". A train named after the
  ISS, Tiangong or Hubble stays in the list when Starlinks are hidden.
- **Every satellite in a big group is drawn where it really is.** From the seventh on, they
  used to be copies of the first one's path, moved in time, which could put a dot over 80°
  from the truth. Each now has a path of its own, and the largest groups need far less data
  than they did in 1.09.
- **The street view follows a satellite you can see.** A big group can start long before the
  satellite it is named after appears, and the view now follows whichever is up until then.
- **Willem Vooijs's licence notice is back**, in `LICENSE.wildekek`. This integration began
  as a fork of see-a-satellite, and its code has been reworked rather than written
  independently, so the MIT notice stays with it. 1.08 and 1.09 went out without it.
- Updating from 1.07 or earlier no longer logs a warning about the stored catalogue.

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
- **The prediction and entity code is reworked.** The Sun's position now comes from Meeus 1998.
  In a test across eight cities the same passes were predicted, with times at most a second
  apart.

## 1.08

- **Orbits now come straight from CelesTrak, and brightness from a table of our own.** The
  integration no longer uses See A Satellite Tonight's catalogue or the pysatellitespotter
  library. The table, `brightness.csv`, holds mostly magnitudes measured by the
  Mini-MegaTORTORA telescope.
- **Which passes are listed changes**, because the brightness values are on a different scale.
  **Faintest magnitude** now defaults to 2.25 rather than 3, in quarter steps, which lists about
  as many passes. If you set your own value it is kept, but it now means something different,
  so it is worth checking.
- **Starlinks are listed 0.75 fainter than your setting**, and a pass now counts as bright below
  magnitude 0.5 rather than 1.
- **The device page** links to the integration's own page rather than See A Satellite Tonight's
  website.
- Planets in the drawn sky use modern colour measurements.
- The first start after updating downloads a new catalogue, and logs that it is ignoring the
  stored one. That warning is harmless.

## 1.07

- **Wording and documentation.** The street view's option now says that only administrators'
  browsers receive the Google and Mapillary keys, the attribution names Space-Track alongside
  CelesTrak, and the README is updated.
- The integration now pins SGP4, its orbit library, to version 2.27.

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
  again. Locations with the same names get the same entity ids.
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
