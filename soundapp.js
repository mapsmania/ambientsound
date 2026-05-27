const debug = document.getElementById("debug");

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: [139.6917, 35.6895], // Tokyo
  zoom: 13,
  pitch: 45,
  bearing: -20,
  attributionControl: false 
});

map.addControl(
  new maplibregl.AttributionControl({
    compact: false, // Set to true if you want it to collapse into an 'i' icon on mobile
    customAttribution: "Sound effects - <a href='https://sound-effects.bbcrewind.co.uk/' target='_blank' rel='noopener noreferrer'>bbc.co.uk</a> – © copyright 2026 BBC"
  })
);

map.addControl(new maplibregl.NavigationControl());
// --------------------------------------------------
// AUDIO OBJECTS (REUSABLE ARCHITECTURE)
// --------------------------------------------------
let mainLimiter;
let trafficSample, waterSample, buildingSample, natureSample; // Changed urbanDrone to buildingSample
let trafficFilter, waterFilter, buildingFilter, natureFilter, natureAutoFilter;
let transitSynth, natureChirpSynth; 

let isAudioInitialized = false;
let isMapMoving = false;

// --------------------------------------------------
// ENVIRONMENT STATE
// --------------------------------------------------
let targetEnvironment = { traffic: 0, urban: 0, nature: 0, water: 0, transit: 0 };
let currentEnvironment = { traffic: 0, urban: 0, nature: 0, water: 0, transit: 0 };

let latestSummary = null;
let latestFeatureCount = 0;

function calculateEnvironment(summary) {
  // 1. Calculate raw, unmodified weights first
  let wRoads = summary.roads * 1.5;
  let wBuildings = summary.buildings * 1.2;
  const wGreenery = summary.greenery * 3.5; 
  const wWater = summary.water * 4.0;       
  const wRail = summary.rail * 2.5;

  // 2. ZOOM RECOVERY LOGIC (Only if the city actually exists nearby!)
  // If we see roads but 0 buildings (common when zoomed out to zoom 11-12),
  // we infer that buildings must exist next to those roads and inject a proxy value.
  const currentZoom = map.getZoom();
  if (summary.buildings === 0 && summary.roads > 0 && currentZoom < 13) {
    wBuildings = (13 - currentZoom) * 2.0; 
  }

  const total = wRoads + wBuildings + wGreenery + wWater + wRail;

  // If the viewport is completely empty or only contains greenery, total escapes here
  if (total === 0) {
    return { traffic: 0, urban: 0, nature: 0, water: 0, transit: 0 };
  }

  // 3. Compute pure ratios
  const mix = {
    traffic: Math.pow(wRoads / total, 0.7),
    urban: Math.pow(wBuildings / total, 0.8),
    nature: Math.pow(wGreenery / total, 0.45),
    water: Math.pow(wWater / total, 0.3),
    transit: Math.pow(wRail / total, 0.5)
  };

  // 4. HARD COLD FLOOR: Absolute safety guard rails
  if (summary.roads === 0) mix.traffic = 0;
  if (summary.buildings === 0 && wBuildings === 0) mix.urban = 0;
  if (summary.greenery === 0) mix.nature = 0;
  if (summary.water === 0) mix.water = 0;
  if (summary.rail === 0) mix.transit = 0;

  return mix;
}
function updateFeatureAnalysis() {
  // Broaden the query to include a small buffer outside the immediate view
  const features = map.queryRenderedFeatures();
  
  const summary = { roads: 0, buildings: 0, water: 0, greenery: 0, rail: 0 };
  const seen = new Set();

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    // Use the internal maplibre id if available
    const uniqueId = feature.id || `${feature.layer.id}-${i}`;
    
    if (seen.has(uniqueId)) continue;
    seen.add(uniqueId);

    const layer = feature.layer.id;
    const props = feature.properties || {};

    // Improved detection: Check layer name AND properties
    if (/road|transportation|bridge/.test(layer)) {
      summary.roads++;
    } else if (/building/.test(layer) || props.class === 'building') {
      summary.buildings++;
    } else if (/water/.test(layer) || props.class === 'water') {
      summary.water++;
    } else if (/park|landcover|landuse|natural/.test(layer) || props.class === 'grass') {
      summary.greenery++;
    }

    if (props.class === "rail" || props.subclass === "rail" || /transit|rail/.test(layer)) {
      summary.rail++;
    }
  }

  latestSummary = summary;
  latestFeatureCount = features.length;
  targetEnvironment = calculateEnvironment(summary);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothEnvironment() {
  const alpha = 0.08;
  currentEnvironment.traffic = lerp(currentEnvironment.traffic, targetEnvironment.traffic, alpha);
  currentEnvironment.urban = lerp(currentEnvironment.urban, targetEnvironment.urban, alpha);
  currentEnvironment.nature = lerp(currentEnvironment.nature, targetEnvironment.nature, alpha);
  currentEnvironment.water = lerp(currentEnvironment.water, targetEnvironment.water, alpha);
  currentEnvironment.transit = lerp(currentEnvironment.transit, targetEnvironment.transit, alpha);
}

// --------------------------------------------------
// AUDIO INITIALIZATION
// --------------------------------------------------
async function initAudio() {
  if (isAudioInitialized) return;
  await Tone.start();
  
  mainLimiter = new Tone.Limiter(-2).toDestination();

  // Traffic Setup
  trafficSample = new Tone.Player({
    url: "https://mapsmania.github.io/ambientsound/traffic.mp3",
    loop: true,
    autostart: false,
    onload: () => {
      console.log("Traffic sample buffered!");
      trafficSample.volume.value = -Infinity;
      trafficSample.start();
    }
  });
  trafficFilter = new Tone.Filter(800, "lowpass").connect(mainLimiter);
  trafficSample.connect(trafficFilter);

  // Water Sample Setup
  waterSample = new Tone.Player({
    url: "https://mapsmania.github.io/ambientsound/water.mp3",
    loop: true,
    autostart: false,
    onload: () => {
      console.log("Water sample buffered!");
      waterSample.volume.value = -Infinity;
      waterSample.start();
    }
  });
  waterFilter = new Tone.Filter(350, "bandpass").connect(mainLimiter);
  waterSample.connect(waterFilter);

  // --------------------------------------------------
  // NEW BUILDINGS / URBAN SAMPLE SETUP
  // --------------------------------------------------
  buildingSample = new Tone.Player({
    url: "https://mapsmania.github.io/ambientsound/buildings.mp3",
    loop: true,
    autostart: false,
    onload: () => {
      console.log("Buildings sample buffered!");
      buildingSample.volume.value = -Infinity;
      buildingSample.start();
    }
  });
  
  // Lowpass filter handles distance: muffles urban chatter far away, opens up nearby
  buildingFilter = new Tone.Filter(400, "lowpass").connect(mainLimiter);
  buildingSample.connect(buildingFilter);

  // Nature Sample Setup
  natureSample = new Tone.Player({
    url: "https://mapsmania.github.io/ambientsound/nature.mp3",
    loop: true,
    autostart: false,
    onload: () => {
      console.log("Nature sample buffered successfully!");
      natureSample.volume.value = -Infinity;
      natureSample.start();
    }
  });

  natureFilter = new Tone.Filter({ type: "lowpass", frequency: 2500 });
  natureAutoFilter = new Tone.AutoFilter({
    frequency: 0.04, 
    depth: 0.3,       
    baseFrequency: 1500, 
    octaves: 1.5
  }).start(); 

  natureSample.chain(natureFilter, natureAutoFilter, mainLimiter);

  // Pre-allocated Transit Synth
  transitSynth = new Tone.MetalSynth({
    frequency: 80,
    envelope: { attack: 0.001, decay: 0.4, release: 0.2 },
    harmonicity: 5.1,
    modulationIndex: 32
  }).connect(mainLimiter);
  transitSynth.volume.value = -18;

  // Pre-allocated Nature Bird-Chirp Synth
  natureChirpSynth = new Tone.Synth({
    oscillator: { type: "triangle" },
    envelope: { attack: 0.002, decay: 0.04, sustain: 0, release: 0.04 }
  }).connect(mainLimiter);
  natureChirpSynth.volume.value = -26;

  isAudioInitialized = true;
  document.getElementById("startAudio").style.display = "none";
  
  startAmbientLoops();
}

// --------------------------------------------------
// ENGINE EXECUTION (TIGHT AUDIO TIMING)
// --------------------------------------------------
function updateAudio() {
  if (!isAudioInitialized) return;

  const rampTime = 0.15; 

  // 1. DYNAMIC TRAFFIC CONTROL
  if (trafficSample && trafficSample.loaded) {
    trafficSample.volume.rampTo(Tone.gainToDb(currentEnvironment.traffic * 1.2 + 0.0001), rampTime);
    const trafficFreq = 200 + (currentEnvironment.traffic * 3300);
    trafficFilter.frequency.rampTo(trafficFreq, rampTime);
  }
    
  // 2. DYNAMIC WATER CONTROL
  if (waterSample.loaded) {
    waterSample.volume.rampTo(Tone.gainToDb(currentEnvironment.water * 1.4 + 0.0001), rampTime);
    const targetWaterFreq = 250 + (currentEnvironment.water * 1500);
    waterFilter.frequency.rampTo(targetWaterFreq, rampTime);
  }

  // --------------------------------------------------
  // 3. DYNAMIC BUILDINGS SAMPLE CONTROL
  // --------------------------------------------------
  if (buildingSample && buildingSample.loaded) {
    // Bring up the volume of the building atmosphere based on urban density
    buildingSample.volume.rampTo(Tone.gainToDb(currentEnvironment.urban * 1.0 + 0.0001), rampTime);
    
    // Smoothly scale frequencies: 300Hz (distant urban blur) to 2800Hz (clear street footsteps/clatter)
    const buildingFreq = 300 + (currentEnvironment.urban * 2500);
    buildingFilter.frequency.rampTo(buildingFreq, rampTime);
  }

  // 4. DYNAMIC NATURE SAMPLE CONTROL
  if (natureSample.loaded) {
    natureSample.volume.rampTo(Tone.gainToDb(currentEnvironment.nature * 1.3 + 0.0001), rampTime);
    const targetNatureFreq = 1500 + (currentEnvironment.nature * 3000);
    natureFilter.frequency.rampTo(targetNatureFreq, rampTime);
    natureAutoFilter.depth.value = currentEnvironment.nature * 0.5;
  }
}

function startAmbientLoops() {
  function scheduleNext() {
    const delay = 400 + Math.random() * 3000;
    setTimeout(() => {
      if (isAudioInitialized) triggerAmbientEvents();
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}

function triggerAmbientEvents() {
  if (Math.random() < currentEnvironment.nature * 0.6) {
    const freq = 1500 + Math.random() * 3500;
    natureChirpSynth.triggerAttackRelease(freq, "32n");
  }

  if (Math.random() < currentEnvironment.transit * 0.5) {
    transitSynth.triggerAttackRelease("16n");
  }
}

// --------------------------------------------------
// COORDINATED EVENT LIFECYCLES
// --------------------------------------------------
map.on("load", () => {
  updateFeatureAnalysis();
});

map.on("movestart", () => { isMapMoving = true; });
map.on("move", () => { if (isMapMoving) updateFeatureAnalysis(); });
map.on("moveend", () => {
  isMapMoving = false;
  updateFeatureAnalysis();
});

function tick() {
  smoothEnvironment();
  updateAudio();

  if (latestSummary) {
    renderDebug(latestSummary, latestFeatureCount);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function renderDebug(summary, totalFeatures) {
  debug.innerHTML = `
    <h2>Oto Fūkei Debug</h2>
    <p><strong>Visible Vectors:</strong> ${totalFeatures}</p>
    <hr>
    <h3>Raw Elements</h3>
    <p>🚗 Roads: ${summary.roads}</p>
    <p>🏢 Buildings: ${summary.buildings}</p>
    <p>🌳 Greenery: ${summary.greenery}</p>
    <p>💧 Water: ${summary.water}</p>
    <p>🚆 Rail: ${summary.rail}</p>
    <hr>
    <h3>Perceptual Mix</h3>
    <p>🚗 Traffic: ${(currentEnvironment.traffic * 100).toFixed(1)}%</p>
    <p>🏙 Urban: ${(currentEnvironment.urban * 100).toFixed(1)}%</p>
    <p>🌿 Nature: ${(currentEnvironment.nature * 100).toFixed(1)}%</p>
    <p>💧 Water: ${(currentEnvironment.water * 100).toFixed(1)}%</p>
    <p>🚆 Transit: ${(currentEnvironment.transit * 100).toFixed(1)}%</p>
  `;
}

document.getElementById("startAudio").addEventListener("click", initAudio);
