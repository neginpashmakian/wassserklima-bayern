WasserKlima Bayern — Progress Presentation
=============================================
(speaking notes — read aloud / adapt to slides)

OPENING
-------
Since our last meeting, I implemented the five features from the future-work
list, went through each of your nine original suggestions one by one to
verify they actually work as described, and fixed several real gaps I found
along the way — including one you'll probably want to hear about, where I
had to build something that wasn't there yet: a genuine multi-river
comparison.

I'll walk through what's new, then say a word about where the data
actually comes from — especially for the Austrian side, since that's the
part reviewers will ask about first.


1. PRECIPITATION-TO-FLOOD CORRELATION
--------------------------------------
You asked: "I want to figure out a year which shows a lot of precipitation
and relate that to whether there has been flooding in the Danube."

Hovering a bar on the drought chart now checks whether that year — or the
year after — had a major flood, and highlights the matching bar on the
flood chart with a pulsing outline and a plain-language note. Originally
this only worked for dry years leading into floods; I extended it so wet
years trigger the same highlight, since "a lot of rain causing a flood" is
the more direct version of what you actually asked for.


2. FLOOD EXTENT BEYOND THE RIVERBANKS
---------------------------------------
For the Deggendorf point you raised — that flooding isn't just the river
getting wider, it's water spreading into areas where the soil couldn't
absorb it — the map now shows shaded polygon overlays for the 2013 and 2002
floods when you scrub the year slider into that range. I want to be upfront
that these are hand-drawn approximations from documented flood descriptions,
not real GIS survey data, and the app labels them "approximate" everywhere
they appear for exactly that reason.


3. LIVE CURRENT CONDITIONS
----------------------------
There's now a live status badge on the Flood tab, and a "NOW" marker on the
Space-Time Wall, pulling in a real-time signal instead of only historical
data. I'll explain the data-source caveat on this one in a moment — it's
important.


4. USER-STEERED PROGRESSIVE LOADING
--------------------------------------
Hovering a decade on the temperature chart now prioritizes fetching that
decade's monthly detail first, so you can explore the specific years you're
curious about instead of waiting for the app's own default schedule.


5. TOUCH-TABLE / IMMERSIVE INTERACTION
-----------------------------------------
For deployment on the department's touch table: multi-finger interaction
works correctly now (dragging the slider no longer also pans the map
underneath), first-time touch users get a short onboarding gesture
sequence, and I added keyboard shortcuts for demo speed — space to
play/pause, arrow keys to step years, number keys to switch tabs — with a
"?" button showing the full list.


6. MULTI-RIVER COMPARISON WALL — built from scratch this round
------------------------------------------------------------------
This was your suggestion: "maybe more of these walls." It didn't exist
before — switching rivers just replaced one wall with another. I built a
genuine side-by-side comparison: pick a second river, and its own
Space-Time Wall appears alongside the first, each with its own
independently-simulated flood series so the comparison isn't just showing
the same numbers twice.


7. THREE CHARTS, ONE SHARED LOADING TIMELINE
-------------------------------------------------
The temperature, drought, and flood charts now genuinely load together —
decade, then yearly, then full history — instead of the flood chart always
showing everything instantly while the other two were still refining.


8. SCROLL ACTUALLY DRIVES THE DATA, NOT JUST AN ANIMATION
--------------------------------------------------------------
This was a real gap I found: scrolling down the page used to just play a
fade-in animation, while the underlying data loaded on its own fixed timer
regardless of whether you'd scrolled at all. Now, the full 1950–2024
history genuinely doesn't load until you scroll into the Drought section —
so your reading pace actually controls when the data resolves, not just
what appears to fade in.


9. MAP MAXIMIZE + GLASS CHART PANELS
-----------------------------------------
A smaller addition: the map can now be maximized to fill the screen for
presenting, with the story charts reachable as frosted-glass overlay panels
on top of it — so you're not forced to shrink the map and scroll away just
to show a chart during a live demo.


DATA SOURCES
==============

Bavaria
-------
Climate data (temperature, precipitation) comes from the Open-Meteo
historical archive API — a real, free, no-key-required service, verified
directly against the live endpoint.

Flood data was intended to come from HND Bayern's official gauge service.
That endpoint is confirmed dead — it returns "object not found," not merely
blocked — so flood levels are simulated, anchored to the real documented
peak levels for major known events (1954, 2002, 2013, 2024), with
plausible interpolated values elsewhere. This is labeled as simulated
throughout the app.

Austria — the part I want to be most precise about
------------------------------------------------------
Climate data for the Austrian towns (Linz, Salzburg, Wels, Braunau) comes
from GeoSphere Austria's DataHub API — the Austrian government's own
climate data service, CC0-licensed, and I verified it's genuinely
CORS-open, so the browser fetches real station data directly, no proxy
needed. Station IDs were looked up from GeoSphere's own metadata endpoint
to make sure each town uses its actual nearest active station.

Flood data for Austria was intended to come from eHYD, the Austrian
Hydrographic Service. eHYD doesn't expose a simple queryable API the way
GeoSphere does — its data is served as HTML, not JSON — so, same as
Bavaria, Austrian flood levels are simulated, anchored to real documented
events for Linz specifically (1954, 1991, 2002, 2006, 2013, and the June
2024 flood), with the same honest "simulated" labeling.

Live "now" data
------------------
HND Bayern's live water-level feed is the same dead endpoint mentioned
above, and the public CORS-proxy fallback I tried is also blocked. So the
"LIVE" badge is actually an estimate derived from live Open-Meteo
precipitation data via a simple rainfall-to-level formula — not a real
sensor reading. It's explicitly labeled "estimated" in the interface itself
so it's never mistaken for a live gauge.

CLOSING LINE
--------------
Across all of this, the guiding rule was: verify before presenting it as
real, and label clearly wherever something is simulated or approximate
rather than measured. I'd rather show you exactly where the real data ends
and the honest simulation begins than have that surface as a surprise
later.
