# Changelog

Each release's notes on GitHub (and in HACS) are its section here. Add the section
before raising the version in `manifest.json`; a release without one lists its
commits instead.

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
