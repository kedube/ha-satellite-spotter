# Changelog

Each release's notes on GitHub (and in HACS) are its section here. Add the section
before raising the version in `manifest.json`; a release without one lists its
commits instead.

## 1.14

- **Licences.** The MIT notice for the code that came from See A Satellite Tonight is back, in
  `LICENSES/MIT-see-a-satellite.txt`, and the release zip now carries it and the GPL.
- **Fixed: the street view could restart every five seconds, for good,** after stepping to another
  photo, or when the nearest photo could not be used. With Google Street View that also meant fetching
  the photo again each time.
- **A rating for every pass:** great, good, fair or poor, weighing how bright it looks against the sky
  at that moment, how high it climbs, how long it lasts, the Moon and the clouds. It is on the page, the
  cards and the calendar, as `sensor.home_next_visible_pass_rating`, and in the pass attributes.
- **Minimum height, by location:** raise it from 10° if trees or buildings hide your horizon.
- **A new action, `satellite_spotter.get_passes`,** lists a location's passes for scripts and voice
  assistants, by time, rating, cloud, kind or name.
- **Clouds from your own weather entity,** if you choose one, so that Open-Meteo is not asked.
  Otherwise Open-Meteo now gets each location's coordinates rounded to about a kilometre, not 10 m.
- **A location can follow a person or tracker,** for travel.
- **The notification blueprint has more to go on. Import it again to use it,** as an imported copy does
  not update itself: a minimum rating, which replaces bright passes as the default, only some kinds of
  satellite or names, quiet hours, and a picture of the pass's path across the sky.
- **Home Assistant starts faster on a bad network.** With a catalogue stored, a location no longer waits
  for CelesTrak or Open-Meteo while starting up, which on a network that accepts and never answers held
  up the whole start by minutes. The new catalogue and the clouds come along just after.
- **A restart with very old orbits keeps the entity that says so,** and the page says why in your
  language, instead of the location retrying setup with no explanation.
- **`device_tracker.home_satellite_position` is disabled for new locations.** It changes all the time,
  and most have no use for it. Enable it in the entity's settings if you want it on a map card.
- **The repair about CelesTrak's own data being old is gone,** as there is nothing to repair. The page
  and the epoch sensor still say so.
- **Short passes are no longer missed.** A window that fell between two minutes of the search, such as
  a satellite rising just as it enters the Earth's shadow, was lost. About one sighting in twenty-five was.
- **A pass that only looked like one is gone.** A Starlink left out for being alone could join two
  unrelated flyovers into one.
- **Fixed on the globe:** the atmosphere glowed on the wrong hemisphere; the satellites stayed away for up
  to five minutes after returning to a dashboard; map tiles that failed stayed black until a reload; Follow
  and Chase were forgotten after a rebuild; the Earth did not fit the screen at high latitudes; following a
  satellite over a pole or on a high orbit zoomed the view far out for good; and without WebGL only one
  sentence showed, where now everything but the globe does.
- **Fixed in orbit lines:** tick marks could sit thousands of kilometres off the orbit for part of each
  hour, and the satellite drifted along a straight line if Home Assistant could not be reached.
- **Fixed in the street view:** it could stay on "Loading your street…" when a photo server stalled; a
  bright cloud could turn a photo by any angle; turning a phone while a photo loaded left it stretched; a
  restart during a search reported photos as unavailable.
- **Fixed on the passes card:** wrong colours on classic dark themes and on light themes per view; a missing
  chart during a pass waited up to five minutes; a location that was deleted went on counting down; and a row
  offered Simulate where only the street view could open.
- **Less battery:** a pass going on that is not the one shown no longer redraws the globe at full speed.
- **Fixed: a pass across the autumn clock change** became a one-second calendar event. It now ends just
  before the change, as Home Assistant's calendars can hold no more.
- **CelesTrak's two-hour limit now holds for broken answers too,** which were being asked for again at once.
- **Safer against a bad server:** downloads stop at a sensible size, and forecast values out of range are
  ignored. A burst of requests from a logged-in user can no longer fill Home Assistant's memory.
- **Medium confidence** no longer says a pass's orbit data is a few days old, as the data is usually
  fresh and the pass simply days ahead. It now reads "a few days from its latest orbit data, so times
  may shift", in every language.
- **MapLibre 6.16, from 6.11.** Its fixes include maps that stopped loading on Safari and iOS after time in
  the background, and maps stuck as one stretched pixel when a phone returned to the page. The camera can now
  follow a satellite right over the poles. MapLibre no longer shares code between its two files, so a browser
  now fetches about 360 KB for it, up from 250 KB.
- The brightness table gains GAOFEN-14 02.

## 1.13

- **Automations and dashboards that use this integration's entities need updating.** The entities are
  new, modelled on [ISS Tracker](https://github.com/kedube/ha-iss-tracker)'s, and the old ones are
  removed by themselves when the update starts. A location keeps its name and place, but the new
  entities' history starts afresh. **Next bright pass** and **Bright pass soon** carry on as they are.

  | Was | Now |
  |---|---|
  | `sensor.home_next_pass` | `sensor.home_next_visible_pass` |
  | `sensor.home_next_bright_pass` | `sensor.home_next_bright_pass` |
  | `sensor.home_passes_next_24h` | `sensor.home_visible_passes_next_24_hours`, and the list is now `upcoming` on the first sensor |
  | `binary_sensor.home_pass_in_progress` | `binary_sensor.home_satellite_visible_now` |
  | `binary_sensor.home_bright_pass_soon` | `binary_sensor.home_bright_pass_soon` |
  | `calendar.home_passes` | `calendar.home_visible_passes` |
  | `sensor.home_catalog_updated` | `sensor.home_orbital_elements_epoch`, with `downloaded` as an attribute |

- **New entities:** the next visible pass's peak elevation, brightness, duration, cloud cover and
  satellite name, **Visible pass soon**, **Satellite elevation**, where that satellite is in your sky
  right now, and **Satellite position**, the point on Earth beneath it, for map cards.
- **Pass attributes have new names.** `object_name` is now `satellite`, `object_count` is
  `satellite_count`, `objects` is `satellites`, `peak_magnitude` is `magnitude`, `is_bright` is
  `bright`, `cloud_percent` is `cloud_cover` and `length_seconds` is `duration_seconds`. `appears`,
  `best_view` and `disappears` are now `start`, `peak` and `end`, and `peak` is now the highest point
  rather than the brightest. `confidence`, `kind`, `appears_from_shadow` and `disappears_into_shadow` are
  new. Times are now in local time.
- **Set your Brightness cutoff and Cloud forecast again if you changed them.** Their names changed, so
  they go back to their defaults. **Faintest magnitude** is now **Brightness cutoff**, from -1 to 4, and
  **Cloud cover forecast** is **Cloud forecast**.
- **Updating from 1.10 or earlier? Import the notification blueprint again**, or it will stop
  notifying by default. An imported copy does not update itself.
- **Passes are searched for only when the orbits change,** every 12 hours rather than every 2, so
  Home Assistant does a sixth of the work. Cloud forecasts now refresh every hour rather than every 2,
  and a forecast that briefly can't be reached no longer takes the clouds off every pass.
- **Home Assistant stays more responsive during that search.** The work now comes in smaller pieces,
  so on a fast computer the longest pause fell from about 50 ms to about 10 ms. The same passes are
  predicted.
- **CelesTrak's two-hour limit now holds in more cases.** A clock stepping back just after a refusal
  asked CelesTrak again at once, as did a restart with the clock behind, a download that stopped partway
  and one interrupted by a reload. Each now waits the two hours.
- **Fixed: moving a location reloaded it twice,** asking Open-Meteo twice.
- **Fixed: removing the last location and adding it back could leave the page showing old satellite
  details** until the next download.
- **The street view does less when there is nothing to see.** With no satellite up, a live view
  redraws once a second instead of about ten times. It stops when scrolled out of sight, and repaints
  its sky far less often.
- **"Look at the satellite" no longer keeps the street view busy.** Pressed with no satellite up, it
  left the view redrawing on every frame.
- **Mini-MegaTORTORA's team has given permission** to use its measurements and to download them once a
  week, so the brightness table can be updated more often. The README and the table now cite both
  papers the team asks for, and each entity's attribution no longer names Kazan Federal University,
  which the team does not ask for.
- **Credit.** Satellite Spotter began as a fork of Willem Vooijs's See A Satellite Tonight integration
  and see-a-satellite library, and the README now says so.

## 1.12

- **The integration's Python code is rewritten.** Its prediction, catalogue, entity and setup modules were
  written anew from a written specification and the tests, by an author that did not see the earlier
  code. In a test across ten cities the same passes were predicted, 2 of 434 starting a second earlier.

## 1.11

- **If you imported the notification blueprint, import it again.** An imported copy does not update
  itself, and the old one cannot recognise bright passes under the new event titles, so by default
  it would stop notifying.
- **Pass attributes have new names, so automations that read them need updating.** Entity ids stay the
  same.
  - `satellite` is now `object_name`, `norad_id` is `catalog_number`, `info_url` is `about_url`.
  - `satellite_count` is now `object_count`, and `satellites` is `objects`.
  - `magnitude` is now `peak_magnitude`, `bright` is `is_bright`, `cloud_cover` is `cloud_percent`.
  - `start` is now `begins`, `end` is `ends`, `duration` is `length_seconds`.
  - `brightest_time`, `_direction`, `_azimuth` and `_elevation` are now `best_view_time` and so on.
  - In the `passes` list, `satellite` is now `title`, and `direction` is `appears_direction`. The other
    fields there follow the names above.
  - On the catalogue sensor, `satellites` is now `catalog_size`.
- **Calendar event titles are new**, the same in every language: `🌟 ISS` for a bright pass and `🔭 ISS`
  for any other, in place of `🛰️ ISS (bright)`. An automation that reads the old title needs updating.
  Notification titles no longer start with a satellite symbol.
- **A pass's id is now the moment it starts**, as in `1793855312`. A link to a pass from before updating
  no longer opens it.
- **"About" links** go to Wikipedia for the ISS, Tiangong and Hubble, and to the satellite's page on N2YO
  for everything else.
- **Hide Starlink keeps bright passes.** A bright rocket stage flying among Starlinks stays in the list.
- **"Starlink train" counts only the Starlinks**, not what flies with them.
- **The street view moves less in big groups.** It stays with a satellite while it is up, then takes the
  one that will stay longest, and with none up it waits where the next will appear.
- `LICENSE.wildekek` is gone.

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
- **"Bright pass soon" counts from the bright satellite.** Its advance notice used to count from
  the start of the whole pass, which in a big group can be long before the bright satellite
  appears. The calendar event, and so the blueprint's notification, still start with the whole
  pass.
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
