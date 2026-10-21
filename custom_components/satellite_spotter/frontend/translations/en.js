/**
 * English text for the globe, the dashboard card and the sidebar panel.
 *
 * English is built in, so there is always something to show; every other
 * language is a JSON file beside this one with the same keys (a key it lacks
 * shows in English). {name} placeholders are filled in by the code. A value
 * with "one" and "other" is chosen by {count}; languages with more plural
 * forms add "few" and "many".
 */
export default {
  // The 16 compass points, clockwise from north, as the integration names
  // them. Translations follow Home Assistant's weather card.
  compass: ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"],
  // The dashboard cards: the globe card (name, description) and the passes
  // card (passes_*), as the card picker lists them, and the passes card itself.
  card: {
    name: "Satellite globe",
    description:
      "A 3D Earth with the satellites you can see from home: the next pass, its orbit, a countdown and the view from your street.",
    load_failed: "Could not load the satellite globe. Check the connection, or reload the page.",
    passes_name: "Satellite passes",
    passes_description:
      "The next satellites you can see from home: when, where to look and how bright, with a countdown and a sky chart.",
    passes_load_failed: "Could not load the satellite passes. Check the connection, or reload the page.",
    // The top of the passes card.
    next_pass: "Next pass",
    next_bright_pass: "Next bright pass",
    visible_now: "Visible now",
    bright: "Bright",
    // {day} is a part of a day, such as "Tonight"; {time} a time of day.
    when: "{day} · {time}",
    // {direction} is a compass point; {elevation} an angle such as "26°".
    look_up: "Look {direction}, {elevation} up",
    look_towards: "Look {direction}",
    // {countdown} is a time such as "02:13"; then how the pass ends.
    ends_in: "Ends in {countdown}",
    ends_set: "sets in the {direction}",
    ends_shadow: "fades into Earth's shadow in the {direction}",
    ends_sky: "fades from view in the {direction}",
    simulate: "Simulate",
    street_view: "Street view",
    // {title} is the satellite, {time} when the pass starts.
    open: "{title} at {time}: open in Satellite Spotter",
    all_passes: "All passes",
    none_soon: "None soon",
    none_why:
      "Satellites can only be seen for a while after dusk and before dawn, when the Sun lights them but your sky is dark.",
    spotter: "Satellite Spotter",
    paused: "Predictions paused",
    paused_clock: "Orbit data out of date",
    paused_age: {
      one: "Orbit data is {count} day old",
      other: "Orbit data is {count} days old",
    },
    // {text} is one of the other messages; {error} why the download failed.
    with_error: "{text} ({error})",
    paused_detail: "Passes come back once fresh orbit data downloads.",
    waiting: "Waiting for the satellite catalogue…",
    // {reason} is a short technical message.
    waiting_because: "Waiting for the satellite catalogue… ({reason})",
    not_set_up: "Set up the Satellite Spotter integration to see passes here.",
    location_gone: "The location this card shows no longer exists. Edit the card and choose a location.",
    location_disabled:
      "This location is disabled. Enable it under Settings > Devices & services, or choose another location.",
    // {error} is a technical message, usually in English.
    failed: "Could not load the passes ({error}). Trying again shortly.",
    close: "Close",
  },
  // The cards' settings in the dashboard editor.
  editor: {
    entry_id: "Location",
    entry_id_helper: "Leave empty to show the first location.",
    imagery: "Imagery",
    imagery_satellite: "Satellite (NASA Blue Marble, Sentinel-2 close up)",
    imagery_esri: "Satellite, high detail close up (Esri)",
    imagery_streets: "Street map close up (OpenStreetMap)",
    view: "Start view",
    view_home: "My location",
    view_follow: "Follow the satellite",
    view_chase: "Fly along with the satellite",
    labels: "Place names and borders",
    show_track: "Course lines",
    show_night: "Day and night",
    show_footprint: "Area that can see the satellite",
    show_home_zone: "Your visibility cone",
    show_countdown: "Next pass and countdown",
    show_stats: "Position and speed",
    show_satellites: "Every bright satellite",
    show_satellites_helper: "All the satellites of the catalogue as dots around the Earth.",
    show_passes: "Upcoming passes",
    show_passes_helper: "A strip of the next passes under the countdown.",
    street_view: "Street view button",
    cooperative_gestures: "Require two fingers or Ctrl to move the map",
    height: "Height (masonry dashboards)",
    // The passes card.
    count: "Passes listed",
    count_helper: "How many passes to list after the next one.",
    bright_only: "Bright passes only",
    hide_starlink: "Hide Starlink",
    show_chart: "Sky chart",
  },
  panel: {
    title: "Satellite Spotter",
    sidebar: "Sidebar",
    location: "Location",
  },
  // The globe (track D1): what it says while it loads, and when something is wrong.
  globe: {
    name: "Satellite pass",
    acquiring: "Finding the satellites…",
    reloading: "Reloading the globe…",
    reload: "Reload the page",
    // {error} is a technical message, usually in English.
    load_failed: "The globe could not load ({error}). Reload the page to try again.",
    load_retrying: "The globe could not load ({error}). It will try again; reloading the page also helps.",
    no_webgl: "This browser cannot show the 3D globe (WebGL 2 is needed): {error}",
    connection_lost: "connection lost",
    reconnecting: "Lost the connection to Home Assistant. Reconnecting…",
    not_set_up: "Set up the Satellite Spotter integration to see satellites here.",
    location_gone_panel: "This location no longer exists. Choose another one.",
    location_gone_card: "The location this card shows no longer exists. Edit the card and choose a location.",
    location_disabled:
      "This location is disabled. Enable it under Settings > Devices & services, or choose another location.",
    waiting: "Waiting for satellite data…",
    waiting_because: "Waiting for satellite data… ({reason})",
    stale_catalog: "The satellite catalogue is out of date, so predictions are paused.",
    data_failed: "Could not load the satellite passes: {error}",
    simulation_failed: "The simulation is unavailable: {error}",
    street_failed: "The street view could not load: {error}",
    pass_gone: "That pass is no longer in the predictions.",
    // A satellite picked among all of them on the globe.
    following: "Following {name}",
    close: "Close",
    // The note beside a satellite under the pointer. {when} is a day and a time.
    tip_visible_now: "Visible from home now",
    tip_next: "Next visible {when}",
    tip_no_pass: {
      one: "No visible pass in the next day",
      other: "No visible pass in the next {count} days",
    },
    tip_follow: "Click to follow it",
  },
  // The buttons beside the map, and its imagery menu (track D1).
  controls: {
    home: "Show my location",
    follow: "Follow the satellite",
    chase: "Fly along with the satellite",
    flat: "Switch between globe and flat map",
    flat_label: "Flat map",
    satellites: "Show every satellite in the catalogue",
    satellites_label: "All satellites",
    imagery: "Change the imagery",
    imagery_menu: "Imagery",
    imagery_satellite: "Satellite (Sentinel-2)",
    imagery_esri: "Satellite, high detail (Esri)",
    imagery_streets: "Street map (OpenStreetMap)",
  },
  // The map's own buttons and hints (MapLibre) (track D1).
  maplibre: {
    zoom_in: "Zoom in",
    zoom_out: "Zoom out",
    reset_bearing: "Drag to rotate map, click to reset north",
    fullscreen_enter: "Enter fullscreen",
    fullscreen_exit: "Exit fullscreen",
    attribution: "Toggle attribution",
    map: "Map",
    marker: "Map marker",
    ctrl_scroll: "Use Ctrl + scroll to zoom the map",
    cmd_scroll: "Use ⌘ + scroll to zoom the map",
    two_fingers: "Use two fingers to move the map",
  },
  // The card at the top of the globe about the pass on show (track D1).
  // {direction} is a compass point, {magnitude} a magnitude such as "−3.4",
  // {word} a brightness word ("very bright"), {countdown} "01:58".
  mission: {
    next_pass: "Next pass",
    selected_pass: "Selected pass",
    visible_now: "Visible now",
    simulation: "Simulation",
    sim_approach: "Simulation · fast forward",
    paused: "Predictions paused",
    bright: "Bright",
    mag: "Mag {magnitude}",
    about: "About this satellite",
    about_name: "About {name}",
    look_up: "Look {direction}, {elevation}° up",
    look_towards: "Look {direction}",
    ends_in: "Ends in {countdown}, setting in the {direction}",
    ends_shadow: "Ends in {countdown} · fades into Earth's shadow in the {direction}",
    ends_sky: "Ends in {countdown} · fades from view in the {direction}",
    brightness: "{word}, mag {magnitude}",
    brightness_now: "Magnitude {magnitude} · {word}",
    // {day} is "Tonight", "Tomorrow morning", "Monday evening"…, {time} a time.
    when: "{day} · {time}",
    passed: "Passed",
    none_soon: "None soon",
    paused_clock: "Satellite data out of date",
    paused_age: {
      one: "The satellite catalogue is {count} day old",
      other: "The satellite catalogue is {count} days old",
    },
    paused_detail: "Passes come back once a fresh catalogue downloads. Positions shown are approximate.",
    paused_list: "Predictions are paused until a fresh satellite catalogue downloads.",
    // What may make a pass easier or harder to see (the cloud and the Moon are passes.cloud_at and passes.moon).
    before_sunset: "Before sunset: the sky is still bright",
    train_hint: "A train of satellites: scan along the whole path",
    with: "With {name}",
    confidence_high: "High confidence",
    confidence_medium: "Medium confidence: orbit data a few days old",
    confidence_low: "Low confidence: old orbit data",
    simulate: "Simulate",
    simulate_short: "Simulate",
    simulate_hint: "Replay the pass on the globe",
    street: "Street view",
    street_short: "Street",
    street_hint: "See the pass from your street",
    look: "Where to look",
    look_short: "Look up",
    look_hint: "Sky chart of the pass",
  },
  // Passes on the globe and in the strip of passes (track D1).
  pass: {
    // The label on the globe at the start of the pass.
    pin: "{title} · {time} · mag {magnitude}",
    simulate_this: "Simulate this pass",
    up_to: "up to {elevation}°",
    now: "Now",
    all: "All passes",
    // Above the list beside the globe.
    list: "Visible passes",
    strip: "Passes",
    // How many times the satellite goes round the Earth before the pass.
    orbits_away: {
      one: "{count} orbit away",
      other: "{count} orbits away",
    },
  },
  // The strip along the bottom about the satellite on show (track D1).
  // {value} and {distance} are shown in bold.
  telemetry: {
    altitude: "Altitude {value}",
    speed: "Speed {value}",
    approximate: "(approximate)",
    sunlit: "In sunlight",
    shadow: "In Earth's shadow",
    distance: "{distance} from {place}",
    above_horizon: "{elevation}° above your horizon",
  },
  // The "where to look" sky chart and its caption (track D1). The caption is
  // {start}, {peak} and {end} put together; {direction} is a compass point.
  sky: {
    chart: "Sky chart of the pass",
    // North, east, south and west around the chart: room for two letters.
    cardinals: ["N", "E", "S", "W"],
    start_rise: "Appears low in the {direction}",
    start_shadow: "Appears out of Earth's shadow in the {direction}, {elevation}° up",
    start_sky: "Appears in the {direction}, {elevation}° up",
    peak: "climbs to {elevation}° in the {direction}",
    end_set: "sets in the {direction}",
    end_shadow: "fades into Earth's shadow in the {direction}",
    end_sky: "fades from view in the {direction}, {elevation}° up",
    caption: "{start}, {peak}, {end}.",
    // When it is highest as it appears.
    caption_short: "{start}, {end}.",
  },
  // Countdowns ("1d 07:42:13") and durations ("2 h 14 min").
  time: {
    countdown_days: "{days}d {time}",
    under_minute: "under a minute",
    seconds: "{seconds} s",
    minutes: "{minutes} min",
    hours: "{hours} h",
    hours_minutes: "{hours} h {minutes} min",
    days_hours: "{days} d {hours} h",
    // {duration} is one of the durations above.
    now: "now",
    in: "in {duration}",
    ago: "{duration} ago",
    // Parts of a day, for the headings of the pass list: morning is midnight
    // to noon, afternoon noon to 5 PM, evening 5 PM to midnight. {weekday} is
    // a day's full name, such as "Monday".
    this_morning: "This morning",
    this_afternoon: "This afternoon",
    tonight: "Tonight",
    tomorrow_morning: "Tomorrow morning",
    tomorrow_afternoon: "Tomorrow afternoon",
    tomorrow_evening: "Tomorrow evening",
    weekday_morning: "{weekday} morning",
    weekday_afternoon: "{weekday} afternoon",
    weekday_evening: "{weekday} evening",
    yesterday_morning: "Yesterday morning",
    yesterday_afternoon: "Yesterday afternoon",
    last_night: "Last night",
  },
  // ---- Satellite Spotter groups. Each build track edits only its own groups
  // (see the design spec); re-read this file immediately before every edit.
  // Pass list, its groups and filters (track D2).
  passes: {
    // {count} satellites following each other across the sky.
    train_title: "Starlink train · {count}",
    // Forecast cloud cover at the time of a pass.
    cloud_clear: "Clear sky",
    cloud_partly: "Partly cloudy",
    cloud_cloudy: "Cloudy",
    // {percent} is a percentage, such as "37%".
    cloud_cover: "{percent} cloud cover",
    // The forecast for the hour after the pass begins: {cloud} is "13%", {time} an hour, such as "6 AM".
    cloud_at: "{cloud} cloud at {time}",
    // A bright Moon up during the pass washes out faint satellites. {percent}
    // is how much of it is lit ("78%"), {elevation} an angle such as "25°",
    // {direction} a compass point.
    moon: "Moon {percent} lit, {elevation} up in the {direction}",
    // The filter buttons above the list.
    filters: "Filters",
    bright_only: "Bright only",
    hide_starlink: "Hide Starlink",
    // A pass going on right now.
    now: "Now",
    // The star on a pass the integration calls bright: brighter than magnitude
    // 1 against a dark enough sky.
    bright: "Bright pass",
    daylight: "Daylight",
    daylight_hint: "Before sunset: only a very bright satellite shows against the daylight sky",
    // Another satellite of note in the same group, such as the ISS.
    with: "with {name}",
    magnitude: "magnitude {magnitude}",
    // {elevation} is an angle above the horizon, such as "67°".
    up_to: "up to {elevation}",
    // {from} and {to} are compass points.
    from_to: "from {from} to {to}",
    // The buttons on each pass. {title} is the satellite, {time} when the pass starts.
    simulate: "Simulate {title} at {time}",
    simulate_short: "Simulate",
    simulate_hint: "Simulate the pass on the globe",
    street: "Street view of {title} at {time}",
    street_short: "Street view",
    street_hint: "See the pass from your street",
    // Below the last pass.
    footer: {
      one: "That's all for the next day.",
      other: "That's all for the next {count} days.",
    },
    hidden: {
      one: "1 pass is hidden by the filters.",
      other: "{count} passes are hidden by the filters.",
    },
    show_all: "Show all",
    empty_filtered: "No pass matches the filters.",
    // No pass at all, and why (after James Darpinian's See A Satellite Tonight).
    empty: {
      one: "No satellites bright enough to see in the next day.",
      other: "No satellites bright enough to see in the next {count} days.",
    },
    why_not: "Why not?",
    why_not_text:
      "Thousands of satellites orbit the Earth, but only a few are close enough and large enough to see easily. Even a bright one can only be seen at the right time: in the middle of the night satellites are in Earth's shadow, so they show for a short while after dusk and before dawn.",
    check_back: "Check back later",
    check_back_text: {
      one: "Tomorrow there may be new chances to see one.",
      other: "In {count} days there may be new chances to see one.",
    },
  },
  // Kinds of object, as the integration tells them apart (track D2).
  kinds: {
    iss: "Space station",
    tiangong: "Space station",
    hubble: "Space telescope",
    starlink: "Starlink satellite",
    rocket: "Rocket body",
    debris: "Debris",
    satellite: "Satellite",
    // Many Starlink satellites following each other.
    train: "Starlink train",
  },
  // How bright a satellite looks, from its magnitude (track D2): dazzling is
  // brighter than magnitude −2, very bright below 0, bright below 1.5, easy to
  // see below 2.5, faint otherwise.
  brightness: {
    dazzling: "dazzling",
    very_bright: "very bright",
    bright: "bright",
    easy: "easy to see",
    faint: "faint",
  },
  // The simulation time bar shared by the globe and the street view (track D1).
  // {countdown} is "01:23" or "1d 02:03:04"; {rate} a number such as 7.3.
  timebar: {
    name: "Simulation controls",
    simulation: "Simulation",
    fast_forward: "Fast forward",
    live_tag: "Live",
    play: "Play",
    pause: "Pause",
    again: "Play again",
    replay: "Replay the pass",
    live: "Back to live",
    live_short: "Live",
    street: "Street view",
    street_hint: "See this moment from your street",
    globe: "Globe",
    globe_hint: "See this moment on the globe",
    close: "Close",
    speed_label: "Playback speed",
    loop: "Replay the pass over and over",
    // "Auto" replays the visible part of the pass in about 20 seconds.
    speed_fit: "Auto · {rate}×",
    speed: "{rate}×",
    seek: "Simulated time",
    appears_in: "appears in {countdown}",
    visible_left: "visible, {countdown} left",
    starts_in: "starts in {countdown}",
    after: "after the pass",
  },
  // The street view (track B): a pass seen from the street. {direction} is a
  // compass point, {time} a time with seconds, {countdown} "01:20".
  street: {
    title: "Street view",
    state_sim: "Simulation",
    state_live: "Live",
    state_live_now: "Visible now",
    bright: "Bright",
    daylight: "Daylight",
    loading: "Loading your street…",
    loading_detail: "Buildings, trees and terrain around your home, from OpenStreetMap and open elevation data",
    loading_photo: "Looking for a street photo near your home",
    loading_path: "Loading the satellite's path…",
    path_failed: "Could not load the satellite's path",
    reloading: "Reloading the street view…",
    no_location: "This location has no coordinates.",
    ready: "Street view ready",
    // The stage's label for screen readers, kept up to date as the view turns.
    facing: "Street view, facing {direction}, {elevation}° up",
    keys: "Drag or use the arrow keys to look around, plus and minus to zoom. Space plays or pauses, F follows the satellite, L looks at it, Home shows the whole pass, Escape closes.",
    look_up: "Look {direction}, {elevation}° up",
    in_shadow: "In Earth's shadow, {direction} {elevation}° up",
    magnitude: "magnitude {magnitude}",
    appears_in: "Appears in {countdown} in the {direction}",
    gone: "Out of sight",
    // Markers on the path.
    appears: "Appears {time}",
    emerges: "Emerges from shadow {time}",
    sets: "Sets {time}",
    fades_shadow: "Fades into shadow {time}",
    fades_sky: "Fades from view {time}",
    // Beside the arrow at the edge of the view: when the satellite comes into it.
    in: "in {countdown}",
    hidden_until_buildings: "Hidden behind buildings until {time}",
    hidden_from_buildings: "Goes behind buildings at {time}",
    hidden_until_terrain: "Hidden behind the hills until {time}",
    hidden_from_terrain: "Goes behind the hills at {time}",
    // The 3D view cannot tell which of the two hides the satellite.
    hidden_until_buildings_or_terrain: "Hidden behind buildings or hills until {time}",
    hidden_from_buildings_or_terrain: "Goes behind buildings or hills at {time}",
    // The 3D model with trees: its read-back cannot tell a building from a tree or a hill.
    hidden_until_model: "Hidden behind buildings, trees or hills until {time}",
    hidden_from_model: "Goes behind buildings, trees or hills at {time}",
    // A photo cannot tell a building from a tree either.
    hidden_until_photo: "Hidden behind buildings or trees until {time}",
    hidden_from_photo: "Goes behind buildings or trees at {time}",
    close: "Close the street view",
    layers: "Layers",
    info: "About this view",
    frame: "Show the whole pass",
    look_at: "Look at the satellite",
    follow: "Follow the satellite",
    phone: "Point your phone at the sky",
    // What the street is: a 360° photo taken near home, or the 3D model made from map data.
    street: "Street",
    street_photo: "Photo",
    street_model: "3D model",
    // Which service's photos: "Best" takes the best of every service there is a key for (the others are names).
    photo_source: "Photos from",
    photo_source_auto: "Best",
    // Under the choice, where the photo shown was taken: {distance} is like "40 m", {direction} a compass point.
    photo_where: "Taken {distance} {direction} of home",
    photo_here: "Taken at home",
    photo_count: "Photo {index} of {count}",
    photo_prev: "Previous photo",
    photo_next: "Next photo",
    photo_open: "View the photo",
    // Google's own link, shown with its photos.
    photo_report: "Report a problem with this image",
    // Why the 3D model shows although photos are chosen ({distance}: the farthest a photo may be from home).
    photo_none: "No street photo within {distance} of home: showing the 3D model.",
    photo_failed: "The street photos near home could not be shown: showing the 3D model.",
    photo_unavailable: "Street photos are unavailable just now: showing the 3D model.",
    // Under the photos, when one of several services sent none ({source}: its name).
    photo_source_failed: "{source} did not answer just now.",
    photo_source_refused: "{source} refused the key in the integration's options.",
    ground: "Ground",
    ground_map: "Map",
    ground_aerial: "Aerial photo",
    buildings: "Buildings",
    props: "Trees and street lights",
    constellations: "Constellations",
    eye_height: "Eye height",
    metres: "{value} m",
    feet: "{value} ft",
    // How light-polluted the sky is, which decides how many stars show.
    sky: "Night sky",
    sky_rural: "Dark",
    sky_suburban: "Suburb",
    sky_city: "City",
    // {reason} is one of the reason_ texts.
    fallback: "No 3D street here ({reason}): showing the sky over the terrain.",
    reason_webgl: "this browser cannot draw it",
    reason_slow: "too slow on this device",
    reason_failed: "the map could not load",
    degraded_terrain: "Terrain unavailable: the street is shown flat.",
    degraded_ofm: "Buildings unavailable: showing the ground and terrain only.",
    degraded_imagery: "Aerial photos unavailable: showing the map instead.",
    about:
      "The buildings, trees and hills around your home, lit for the moment of the pass, under the stars, planets and Moon as they will be. Trees stand where the map has woods and parks, and street lights along its streets; as many windows are lit as at that hour. The satellite's path is drawn where it will cross your sky, with a dot every 30 seconds; the moving dot is as bright as the satellite will be.",
    about_photo:
      "A 360° photo taken in your street, darkened for the moment of the pass, under the stars, planets and Moon as they will be. The satellite's path is drawn where it will cross your sky, with a dot every 30 seconds; the buildings and trees in the photo hide it where they will. The moving dot is as bright as the satellite will be.",
    legend_visible: "Visible: sunlit and bright enough to see",
    legend_faint: "Sunlit, but too low or too faint for the sky",
    legend_shadow: "In Earth's shadow",
    legend_hidden: "Behind buildings or hills",
    legend_hidden_photo: "Behind buildings or trees",
    legend_hidden_model: "Behind buildings, trees or hills",
    privacy_title: "Privacy",
    privacy:
      "Home Assistant works out the pass. To draw the street, your browser downloads map tiles of the area around your home from OpenFreeMap and Amazon Web Services (and from Esri for aerial photos). Like any web map, their servers can see which area is shown. Nothing else is sent.",
    privacy_photo:
      "Home Assistant works out the pass. For the street, your browser asks Panoramax for photos taken near your home and downloads the one shown from the server that keeps it. Like any web map, their servers can see which area is asked about. Nothing else is sent.",
    // Under the 3D model's privacy note, when photos were asked for.
    privacy_photo_search:
      "With street photos chosen, your browser also asks Panoramax for photos taken near your home.",
    // After the privacy note, with Mapillary or Google keys set ({services}: their names, as a list).
    privacy_photo_services:
      "With the keys in the integration's options, your browser also asks {services} for photos taken near your home.",
    credits: "Credits",
    credit_map: "Map and buildings",
    credit_terrain: "Terrain",
    credit_imagery: "Aerial photos",
    credit_stars: "Stars",
    credit_engine: "3D map",
    credit_photo: "Street photo",
    // The credits' sentences: {openfreemap}, {openmaptiles}, {openstreetmap}, {tiles} and
    // {d3celestial} are links with the names in them.
    credit_map_text: "{openfreemap} © {openmaptiles}, data © {openstreetmap} contributors",
    credit_terrain_text: "{tiles} on AWS Open Data (USGS 3DEP, SRTM, GMTED2010, EU-DEM, ETOPO1 and others)",
    credit_stars_text:
      "Yale Bright Star Catalogue, 5th ed. (Hoffleit & Warren 1991; VizieR V/50, CDS Strasbourg); star names: IAU Working Group on Star Names (CC BY 4.0); constellation figures: {d3celestial} © 2015 Olaf Frohn (BSD-3-Clause), after the IAU and Sky & Telescope charts",
    // {author} links to the photo on Panoramax (its photographer), {license} to its licence, {panoramax} to Panoramax.
    credit_photo_text: "{author}, {license}, from {panoramax}",
    // {author} links to the photo on Mapillary, {license} to its licence, {mapillary} to Mapillary.
    credit_photo_mapillary_text: "{author}, {license}, from {mapillary}",
    // {copyright} is Google's own line ("© 2024 Google"), {google} links to the panorama on Google Maps.
    credit_photo_google_text: "{copyright}, from {google}",
    done: "Done",
  },
  // The planetarium sky drawn behind the street view (track B).
  planetarium: {
    moon: "Moon",
    mercury: "Mercury",
    venus: "Venus",
    mars: "Mars",
    jupiter: "Jupiter",
    saturn: "Saturn",
  },
};
