/**
 * NEON RACER - 3D WebGL Synthwave Racer
 * Powered by Three.js
 */

// Game Configuration & Constants
const ROAD_WIDTH = 10.0;
const LANE_WIDTH = 3.0;
const MAX_X = 4.1; // Car steering boundary inside 10-wide road
const ROAD_LENGTH = 320;
const SPAWN_INTERVAL = 950; // Faster spawns
const SPEED_ACCEL = 0.98; // acceleration rate
const SPEED_DECEL = 0.85; // coasting deceleration rate
const BRAKE_DECEL = 4.2;  // hard braking deceleration rate

// Shared Optimized Geometry/Material Caches (WebGL GC Optimizations)
let sharedSkidGeom, sharedSkidMat;
let sharedSparkGeom, sharedSparkMat;
let sharedExhaustGeom, sharedExhaustMat;
let sharedParticleGeom;

// Dynamic 3D Skid Marks List
let skidMarks = [];
const MAX_SKID_MARKS = 180; // Performance safety cap

// Sound Effects Synthesizer using Web Audio API
class SoundSynth {
  constructor() {
    this.ctx = null;
    this.engineOsc = null;
    this.engineGain = null;
    this.windNode = null;
    this.windGain = null;
    this.screechOsc = null;
    this.screechGain = null;
    this.muted = false;
    this.initialized = false;

    // Gearbox state variables
    this.currentGear = 1;
    this.lastGear = 1;
    this.shiftTimer = 0; // seconds
  }

  init() {
    if (this.initialized) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      
      this.setupEngine();
      this.setupWindSynth();
      this.setupScreechSynth();
      
      this.initialized = true;
    } catch (e) {
      console.warn("Web Audio API not supported in this browser.", e);
    }
  }

  setupEngine() {
    if (!this.ctx) return;
    
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth'; // Warmer engine sound
    this.engineOsc.frequency.setValueAtTime(45, this.ctx.currentTime);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(140, this.ctx.currentTime);

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.engineOsc.connect(filter);
    filter.connect(this.engineGain);
    this.engineGain.connect(this.ctx.destination);
    
    this.engineOsc.start();
  }

  setupWindSynth() {
    if (!this.ctx) return;

    // Generate White Noise Buffer
    const bufferSize = 2 * this.ctx.sampleRate;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    this.windNode = this.ctx.createBufferSource();
    this.windNode.buffer = noiseBuffer;
    this.windNode.loop = true;

    // Highpass filter for wind rush sound
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(450, this.ctx.currentTime);

    this.windGain = this.ctx.createGain();
    this.windGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.windNode.connect(filter);
    filter.connect(this.windGain);
    this.windGain.connect(this.ctx.destination);

    this.windNode.start();
  }

  setupScreechSynth() {
    if (!this.ctx) return;

    this.screechOsc = this.ctx.createOscillator();
    this.screechOsc.type = 'triangle';
    this.screechOsc.frequency.setValueAtTime(850, this.ctx.currentTime);

    // Distortion or bandpass filter to shape rubber screeching
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900, this.ctx.currentTime);
    filter.Q.setValueAtTime(2.0, this.ctx.currentTime);

    this.screechGain = this.ctx.createGain();
    this.screechGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.screechOsc.connect(filter);
    filter.connect(this.screechGain);
    this.screechGain.connect(this.ctx.destination);

    this.screechOsc.start();
  }

  setEnginePitchAndVolume(speedPercent, isActive, delta) {
    if (!this.initialized || this.muted) return;

    // Speed in units roughly 0 - 300
    const rawSpeed = speedPercent * 300;
    
    // Calculate current Gear
    let gear = 1;
    let rpmFraction = 0;
    
    if (rawSpeed < 55) {
      gear = 1;
      rpmFraction = rawSpeed / 55;
    } else if (rawSpeed < 105) {
      gear = 2;
      rpmFraction = (rawSpeed - 55) / 50;
    } else if (rawSpeed < 160) {
      gear = 3;
      rpmFraction = (rawSpeed - 105) / 55;
    } else if (rawSpeed < 220) {
      gear = 4;
      rpmFraction = (rawSpeed - 160) / 60;
    } else {
      gear = 5;
      rpmFraction = Math.min(1.0, (rawSpeed - 220) / 80);
    }

    // Trigger Gear Shift Lag
    if (gear !== this.lastGear) {
      this.shiftTimer = 0.16; // 160ms clutch shifting lag
      this.lastGear = gear;
    }

    if (isActive) {
      let finalFreq = 0;
      let finalVol = 0;

      if (this.shiftTimer > 0) {
        this.shiftTimer -= delta;
        // Shifting dip (RPM drops, volume lowers momentarily)
        finalFreq = 40; 
        finalVol = 0.04;
      } else {
        // Base gear frequency pitch scaling: ranges from 45Hz up to 180Hz
        const baseFreq = 38 + (gear * 6);
        finalFreq = baseFreq + (rpmFraction * 135);
        finalVol = 0.08 + (rpmFraction * 0.14) + (gear * 0.015);
      }

      if (this.engineOsc) {
        this.engineOsc.frequency.setTargetAtTime(finalFreq, this.ctx.currentTime, 0.05);
      }
      if (this.engineGain) {
        this.engineGain.gain.setTargetAtTime(finalVol, this.ctx.currentTime, 0.05);
      }

      // Wind sound scales directly with speed
      if (this.windGain) {
        const windVol = Math.pow(speedPercent, 2) * 0.06; // exponential volume growth
        this.windGain.gain.setTargetAtTime(windVol, this.ctx.currentTime, 0.1);
      }
    } else {
      if (this.engineGain) this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
      if (this.windGain) this.windGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    }
  }

  setScreechIntensity(intensity) {
    if (!this.initialized || this.muted || !this.screechGain) return;
    
    // Tire screech volume bound to slide velocity
    const vol = Math.min(0.18, intensity * 0.025);
    this.screechGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.08);

    // Dynamic pitch modulation for sliding tires
    if (this.screechOsc) {
      const pitch = 820 + (intensity * 12);
      this.screechOsc.frequency.setValueAtTime(pitch, this.ctx.currentTime);
    }
  }

  playCollectSound() {
    if (!this.initialized || this.muted) return;
    
    const now = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';
    
    osc1.frequency.setValueAtTime(523.25, now); // C5
    osc1.frequency.setValueAtTime(659.25, now + 0.08); // E5
    osc1.frequency.setValueAtTime(783.99, now + 0.16); // G5
    osc1.frequency.setValueAtTime(1046.50, now + 0.24); // C6

    osc2.frequency.setValueAtTime(261.63, now); // C4
    osc2.frequency.setValueAtTime(329.63, now + 0.08); // E4
    osc2.frequency.setValueAtTime(392.00, now + 0.16); // G4

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.4);
    osc2.stop(now + 0.4);
  }

  playCrashSound() {
    if (!this.initialized || this.muted) return;
    
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + 0.55);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(300, now);
    filter.frequency.exponentialRampToValueAtTime(20, now + 0.55);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.65);
  }

  playBoostSound() {
    if (!this.initialized || this.muted) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.exponentialRampToValueAtTime(800, now + 0.4);

    filter.type = 'peaking';
    filter.Q.setValueAtTime(5, now);
    filter.frequency.setValueAtTime(300, now);
    filter.frequency.exponentialRampToValueAtTime(2000, now + 0.4);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.45);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.5);
  }

  toggleMute() {
    this.muted = !this.muted;
    const now = this.ctx ? this.ctx.currentTime : 0;
    if (this.muted) {
      if (this.engineGain) this.engineGain.gain.setValueAtTime(0, now);
      if (this.windGain) this.windGain.gain.setValueAtTime(0, now);
      if (this.screechGain) this.screechGain.gain.setValueAtTime(0, now);
    }
    return this.muted;
  }
}

const synth = new SoundSynth();

// Theme Definitions
const PALETTES = {
  cyberpunk: {
    primary: '#ff007f', // Hot Pink
    secondary: '#00f0ff', // Cyan
    accent: '#ffeb3b', // Yellow
    grid: '#221347',
    fog: '#070314',
    sunTop: '#ff007f',
    sunBottom: '#ffeb3b',
    roadColor: '#0a0518',
    barrierColor: '#ff007f'
  },
  vaporwave: {
    primary: '#f72585', // Magenta
    secondary: '#7209b7', // Purple
    accent: '#4cc9f0', // Soft Cyan
    grid: '#3d0066',
    fog: '#120324',
    sunTop: '#f72585',
    sunBottom: '#7209b7',
    roadColor: '#100220',
    barrierColor: '#7209b7'
  },
  matrix: {
    primary: '#00ff41', // Matrix Green
    secondary: '#008f11', // Dark Green
    accent: '#00ff41',
    grid: '#001c03',
    fog: '#000500',
    sunTop: '#00ff41',
    sunBottom: '#001100',
    roadColor: '#000801',
    barrierColor: '#00ff41'
  },
  'solar-flare': {
    primary: '#ff5722', // Radiant Orange
    secondary: '#ffc107', // Golden Yellow
    accent: '#ffffff',
    grid: '#3e1b00',
    fog: '#160800',
    sunTop: '#ff3d00',
    sunBottom: '#ffeb3b',
    roadColor: '#0f0500',
    barrierColor: '#ff5722'
  },
  'deep-ocean': {
    primary: '#00f5d4', // Teal
    secondary: '#00bbf9', // Aqua Blue
    accent: '#ffe5ec',
    grid: '#001b2e',
    fog: '#000b14',
    sunTop: '#00bbf9',
    sunBottom: '#00f5d4',
    roadColor: '#00050a',
    barrierColor: '#00f5d4'
  },
  'outrun-tokyo': {
    primary: '#ff0055', // Hot Pink
    secondary: '#7a00ff', // Tokyo Purple
    accent: '#00ffcc',
    grid: '#1a0033',
    fog: '#080014',
    sunTop: '#ff0055',
    sunBottom: '#7a00ff',
    roadColor: '#04000a',
    barrierColor: '#ff0055'
  }
};

// Global Game Variables
let selectedPalette = 'cyberpunk';
let theme = PALETTES[selectedPalette];

let scene, camera, renderer;
let gameContainer = document.getElementById('canvas-container');

// Engine variables
let gameState = 'MENU';
let isPaused = false; // Pause state
let score = 0;
let distance = 0;
let speed = 0;
let targetSpeed = 0;
let baseSpeed = 60;
let currentMaxSpeed = 160;
let boostTimer = 0;
let isBoosting = false;
let isBraking = false;
let shield = 100;
let shardsCollected = 0;
let lastSpawnTime = 0;

// Textured road mesh & textures
let roadMesh;
let roadTexture;
let barrierTextureL, barrierTextureR;

// Gameplay objects lists
let obstacles = [];
let shards = [];
let particles = [];

// Player car variables
let carGroup;
let headlightsSpotlight;
let speedBlurOverlay = document.getElementById('boost-overlay');
let carTargetX = 0;

// Camera & View Settings
let cameraView = 'THIRD_PERSON'; // THIRD_PERSON or FIRST_PERSON

// Drift Physics Variables
let driftYawAngle = 0; // Yaw turn angle (turning into drift)
let slideVelocity = 0; // Sideways slide momentum
let isDrifting = false;

// Double-Integration Steering Variables
let carVelocityX = 0;
let carAccelerationX = 0;
const CAR_MASS = 1200; // kg
const STEER_FORCE = 9800; // N
const GRIP_FRICTION = 6.8; // Grip sliding resistance
const DRIFT_FRICTION = 2.0; // Friction sliding resistance when drifting

// Keyboard controls state
const keys = {
  a: false,
  d: false,
  w: false,
  s: false,
  ArrowLeft: false,
  ArrowRight: false,
  ArrowUp: false,
  ArrowDown: false
};

// Camera shake effect variables
let shakeIntensity = 0;
const shakeDecay = 0.9;

/* =========================================================================
   1. PROCEDURAL TEXTURE GENERATION
   ========================================================================= */

function createProceduralRoadTexture(theme) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');

  // Background asphalt
  ctx.fillStyle = theme.roadColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Horizontal Grid lines
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 4;
  for (let y = 0; y < canvas.height; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  // Dashed lane lines
  ctx.lineWidth = 6;
  const laneLines = [canvas.width * 0.33, canvas.width * 0.66];
  ctx.setLineDash([32, 32]);
  laneLines.forEach(lineX => {
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(lineX, 0);
    ctx.lineTo(lineX, canvas.height);
    ctx.stroke();
  });
  ctx.setLineDash([]);

  // Solid glowing margins
  ctx.lineWidth = 16;
  ctx.strokeStyle = theme.secondary;
  ctx.shadowColor = theme.secondary;
  ctx.shadowBlur = 15;
  ctx.beginPath();
  ctx.moveTo(10, 0);
  ctx.lineTo(10, canvas.height);
  ctx.stroke();

  ctx.strokeStyle = theme.primary;
  ctx.shadowColor = theme.primary;
  ctx.beginPath();
  ctx.moveTo(canvas.width - 10, 0);
  ctx.lineTo(canvas.width - 10, canvas.height);
  ctx.stroke();

  ctx.shadowBlur = 0;

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 10);
  return texture;
}

function createProceduralBarrierTexture(colorHex, isLeft) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#110d24';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = colorHex;
  ctx.shadowColor = colorHex;
  ctx.shadowBlur = 10;
  
  const stripeWidth = 24;
  const gap = 48;
  
  for (let y = -stripeWidth; y < canvas.height + stripeWidth; y += gap) {
    ctx.beginPath();
    if (isLeft) {
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y + stripeWidth);
      ctx.lineTo(canvas.width, y + stripeWidth + 12);
      ctx.lineTo(0, y + 12);
    } else {
      ctx.moveTo(canvas.width, y);
      ctx.lineTo(0, y + stripeWidth);
      ctx.lineTo(0, y + stripeWidth + 12);
      ctx.lineTo(canvas.width, y + 12);
    }
    ctx.fill();
  }

  ctx.shadowBlur = 0;

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 8);
  return texture;
}

function createProceduralSunTexture(theme) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const radius = 240;

  const grad = ctx.createLinearGradient(0, centerY - radius, 0, centerY + radius);
  grad.addColorStop(0.0, theme.sunTop);
  grad.addColorStop(0.5, theme.primary);
  grad.addColorStop(1.0, theme.sunBottom);

  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.globalCompositeOperation = 'destination-out';
  
  const sunBottomY = centerY + radius;
  const sunTopY = centerY - radius;
  
  let currentY = centerY - 65;
  
  while (currentY < sunBottomY) {
    const distRatio = (currentY - sunTopY) / (radius * 2);
    const dynamicGap = Math.max(4, Math.floor(distRatio * 19));
    const dynamicBar = Math.max(3, Math.floor((1 - distRatio) * 12));

    ctx.fillRect(0, currentY, canvas.width, dynamicGap);
    currentY += dynamicGap + dynamicBar;
  }

  ctx.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

function createCarCarbonTexture(colorHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#090518';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#170f2f';
  for (let x = 0; x < canvas.width; x += 8) {
    for (let y = 0; y < canvas.height; y += 8) {
      if ((x + y) % 16 === 0) {
        ctx.fillRect(x, y, 4, 4);
      }
    }
  }

  ctx.fillStyle = colorHex;
  ctx.shadowColor = colorHex;
  ctx.shadowBlur = 6;
  ctx.fillRect(48, 0, 8, canvas.height);
  ctx.fillRect(72, 0, 8, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

/* =========================================================================
   2. INITIALIZATION & SETUP
   ========================================================================= */

function initEngine() {
  // Clean up and dispose of old WebGL resources to prevent memory leaks and context loss
  if (scene) {
    scene.clear();
  }
  if (renderer) {
    renderer.dispose();
  }

  scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.fog);
  scene.fog = new THREE.FogExp2(theme.fog, 0.007);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 3.8, 7.5);
  camera.lookAt(0, 1.2, -15);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  
  gameContainer.innerHTML = '';
  gameContainer.appendChild(renderer.domElement);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.22);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
  dirLight.position.set(0, 25, 10);
  dirLight.castShadow = true;
  scene.add(dirLight);

  roadTexture = createProceduralRoadTexture(theme);
  barrierTextureL = createProceduralBarrierTexture(theme.secondary, true);
  barrierTextureR = createProceduralBarrierTexture(theme.primary, false);
  
  createEnvironment();
  createCar();

  // Pre-allocate shared geometries and materials to avoid GC runtime overhead
  sharedParticleGeom = new THREE.BoxGeometry(0.18, 0.18, 0.18);
  sharedSparkGeom = new THREE.BoxGeometry(0.06, 0.06, 0.15);
  sharedSparkMat = new THREE.MeshBasicMaterial({
    color: theme.accent,
    transparent: true,
    opacity: 0.95
  });

  sharedExhaustGeom = new THREE.BoxGeometry(0.08, 0.08, 0.08);
  sharedExhaustMat = new THREE.MeshBasicMaterial({
    color: theme.primary,
    transparent: true,
    opacity: 0.8
  });
  
  sharedSkidGeom = new THREE.PlaneGeometry(0.22, 1.0); // scaled dynamically on Y
  sharedSkidMat = new THREE.MeshBasicMaterial({
    color: 0x05020c,
    transparent: true,
    opacity: 0.58,
    side: THREE.DoubleSide
  });
}

/* =========================================================================
   3. ENVIRONMENT BUILD WITH TEXTURES
   ========================================================================= */

function createEnvironment() {
  const roadGeom = new THREE.PlaneGeometry(ROAD_WIDTH, ROAD_LENGTH);
  const roadMat = new THREE.MeshStandardMaterial({
    map: roadTexture,
    roughness: 0.25,
    metalness: 0.6,
    side: THREE.DoubleSide
  });

  roadMesh = new THREE.Mesh(roadGeom, roadMat);
  roadMesh.rotation.x = -Math.PI / 2;
  roadMesh.position.set(0, 0, -ROAD_LENGTH / 2 + 15);
  roadMesh.receiveShadow = true;
  scene.add(roadMesh);

  // Left & Right Barriers
  const barrierWidth = 0.4;
  const barrierHeight = 0.75;
  const barrierGeom = new THREE.BoxGeometry(barrierWidth, barrierHeight, ROAD_LENGTH);
  
  const barrierMatL = new THREE.MeshStandardMaterial({
    map: barrierTextureL,
    roughness: 0.4,
    metalness: 0.5,
    emissive: theme.secondary,
    emissiveIntensity: 0.12
  });

  const barrierMatR = new THREE.MeshStandardMaterial({
    map: barrierTextureR,
    roughness: 0.4,
    metalness: 0.5,
    emissive: theme.primary,
    emissiveIntensity: 0.12
  });

  const leftBarrier = new THREE.Mesh(barrierGeom, barrierMatL);
  leftBarrier.position.set(-ROAD_WIDTH / 2 - barrierWidth / 2, barrierHeight / 2, -ROAD_LENGTH / 2 + 15);
  scene.add(leftBarrier);

  const rightBarrier = new THREE.Mesh(barrierGeom, barrierMatR);
  rightBarrier.position.set(ROAD_WIDTH / 2 + barrierWidth / 2, barrierHeight / 2, -ROAD_LENGTH / 2 + 15);
  scene.add(rightBarrier);

  createTexturedSun();
  createMountains();
  createStars();
}

function createTexturedSun() {
  const sunTexture = createProceduralSunTexture(theme);

  const sunGeom = new THREE.PlaneGeometry(120, 120);
  const sunMat = new THREE.MeshBasicMaterial({
    map: sunTexture,
    transparent: true,
    side: THREE.DoubleSide,
    fog: false
  });

  const sun = new THREE.Mesh(sunGeom, sunMat);
  sun.position.set(0, 20, -320);
  scene.add(sun);
}

function createMountains() {
  const mountainGeomL = new THREE.PlaneGeometry(150, 200, 10, 10);
  const mountainGeomR = new THREE.PlaneGeometry(150, 200, 10, 10);

  const distortPlane = (geom) => {
    const pos = geom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      if (Math.abs(vy) > 10) {
        const z = Math.abs(vx) * 0.4 + Math.sin(vx * 0.08) * 8 + Math.cos(vy * 0.1) * 10;
        pos.setZ(i, Math.max(0, z));
      }
    }
    geom.computeVertexNormals();
  };

  distortPlane(mountainGeomL);
  distortPlane(mountainGeomR);

  const mountainMat = new THREE.MeshBasicMaterial({
    color: theme.primary,
    wireframe: true,
    transparent: true,
    opacity: 0.14,
    fog: true
  });

  const mountainL = new THREE.Mesh(mountainGeomL, mountainMat);
  mountainL.position.set(-85, 4, -280);
  mountainL.rotation.x = -Math.PI / 2.2;
  mountainL.rotation.z = Math.PI / 5.5;
  scene.add(mountainL);

  const mountainR = new THREE.Mesh(mountainGeomR, mountainMat);
  mountainR.position.set(85, 4, -280);
  mountainR.rotation.x = -Math.PI / 2.2;
  mountainR.rotation.z = -Math.PI / 5.5;
  scene.add(mountainR);
}

function createStars() {
  const starCount = 300;
  const starGeom = new THREE.BufferGeometry();
  const starPositions = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i++) {
    const x = (Math.random() - 0.5) * 450;
    const y = Math.random() * 150 + 10;
    const z = -Math.random() * 350 - 50;

    starPositions[i * 3] = x;
    starPositions[i * 3 + 1] = y;
    starPositions[i * 3 + 2] = z;
  }

  starGeom.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  
  const starMat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.9,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.7,
    fog: false
  });

  const stars = new THREE.Points(starGeom, starMat);
  scene.add(stars);
}

function createCar() {
  carGroup = new THREE.Group();
  carGroup.position.set(0, 0.28, -8);
  scene.add(carGroup);

  const bodyTexture = createCarCarbonTexture(theme.primary);
  
  const bodyMat = new THREE.MeshStandardMaterial({
    map: bodyTexture,
    roughness: 0.15,
    metalness: 0.7,
    emissive: theme.secondary,
    emissiveIntensity: 0.12
  });

  const cabinMat = new THREE.MeshStandardMaterial({
    color: 0x0d071d,
    roughness: 0.05,
    metalness: 0.95,
    transparent: true,
    opacity: 0.8
  });

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7 });
  const wheelGlowMat = new THREE.MeshBasicMaterial({ color: theme.secondary });

  // Chassis
  const bodyGeom = new THREE.BoxGeometry(1.4, 0.4, 2.9);
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  carGroup.add(body);

  // Hood
  const hoodGeom = new THREE.BoxGeometry(1.4, 0.2, 0.9);
  const hood = new THREE.Mesh(hoodGeom, bodyMat);
  hood.position.set(0, -0.05, -1.6);
  hood.rotation.x = 0.08;
  carGroup.add(hood);

  // Cabin
  const cabinGeom = new THREE.BoxGeometry(1.1, 0.35, 1.2);
  const cabin = new THREE.Mesh(cabinGeom, cabinMat);
  cabin.position.set(0, 0.36, 0.1);
  carGroup.add(cabin);

  // Spoiler
  const wingGeom = new THREE.BoxGeometry(1.3, 0.05, 0.4);
  const wing = new THREE.Mesh(wingGeom, bodyMat);
  wing.position.set(0, 0.3, 1.4);
  carGroup.add(wing);

  // Trim strips
  const trimGeom = new THREE.BoxGeometry(0.04, 0.08, 2.5);
  const trimMat = new THREE.MeshBasicMaterial({ color: theme.secondary });
  
  const trimL = new THREE.Mesh(trimGeom, trimMat);
  trimL.position.set(-0.71, -0.08, 0);
  carGroup.add(trimL);

  const trimR = trimL.clone();
  trimR.position.x = 0.71;
  carGroup.add(trimR);

  // Taillights
  const taillightGeom = new THREE.BoxGeometry(0.35, 0.08, 0.05);
  const taillightMat = new THREE.MeshBasicMaterial({ color: 0xff003c });
  
  const taillightL = new THREE.Mesh(taillightGeom, taillightMat);
  taillightL.position.set(-0.42, 0.08, 1.45);
  carGroup.add(taillightL);

  const taillightR = taillightL.clone();
  taillightR.position.x = 0.42;
  carGroup.add(taillightR);

  // Headlights & Spotlight
  const headlightGeom = new THREE.BoxGeometry(0.25, 0.08, 0.05);
  const headlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  
  const headlightL = new THREE.Mesh(headlightGeom, headlightMat);
  headlightL.position.set(-0.42, -0.05, -2.05);
  carGroup.add(headlightL);

  const headlightR = headlightL.clone();
  headlightR.position.x = 0.42;
  carGroup.add(headlightR);

  headlightsSpotlight = new THREE.SpotLight(0x00f0ff, 9, 50, Math.PI / 4, 0.5, 1);
  headlightsSpotlight.position.set(0, 0.2, -1.9);
  headlightsSpotlight.target.position.set(0, -0.5, -30);
  carGroup.add(headlightsSpotlight);
  carGroup.add(headlightsSpotlight.target);

  // Wheels
  const wheelGeom = new THREE.CylinderGeometry(0.32, 0.32, 0.28, 12);
  wheelGeom.rotateZ(Math.PI / 2);
  const rimGeom = new THREE.CylinderGeometry(0.18, 0.18, 0.31, 10);
  rimGeom.rotateZ(Math.PI / 2);

  const wheelPositions = [
    [-0.75, -0.15, -0.85],
    [0.75, -0.15, -0.85],
    [-0.75, -0.15, 0.85],
    [0.75, -0.15, 0.85]
  ];

  wheelPositions.forEach((pos, idx) => {
    const wheelWheel = new THREE.Mesh(wheelGeom, wheelMat);
    const wheelRim = new THREE.Mesh(rimGeom, wheelGlowMat);
    const wheelAssembly = new THREE.Group();
    wheelAssembly.position.set(pos[0], pos[1], pos[2]);
    wheelAssembly.add(wheelWheel);
    wheelAssembly.add(wheelRim);
    wheelAssembly.name = `wheel_${idx}`;
    carGroup.add(wheelAssembly);
  });
}

/* =========================================================================
   4. SPAWNER LOOPS (NARROW ROAD LANES)
   ========================================================================= */

function spawnObstacle() {
  if (gameState !== 'PLAYING') return;

  const lanes = [-LANE_WIDTH, 0, LANE_WIDTH];
  const targetLane = lanes[Math.floor(Math.random() * lanes.length)];
  
  const obsTexture = createProceduralBarrierTexture(theme.primary, true);

  const blockGeom = new THREE.BoxGeometry(2.0, 0.85, 0.6);
  const blockMat = new THREE.MeshStandardMaterial({
    map: obsTexture,
    roughness: 0.3,
    metalness: 0.6,
    emissive: theme.primary,
    emissiveIntensity: 0.12
  });

  const borderGeom = new THREE.BoxGeometry(2.1, 0.1, 0.7);
  const borderMat = new THREE.MeshBasicMaterial({ color: theme.primary });

  const obstacleGroup = new THREE.Group();
  obstacleGroup.position.set(targetLane, 0.42, -280);
  
  const barMesh = new THREE.Mesh(blockGeom, blockMat);
  const glowTop = new THREE.Mesh(borderGeom, borderMat);
  glowTop.position.y = 0.42;
  const glowBottom = new THREE.Mesh(borderGeom, borderMat);
  glowBottom.position.y = -0.42;

  const flashLight = new THREE.PointLight(theme.primary, 3.5, 12);
  flashLight.position.set(0, 0.7, 0);
  obstacleGroup.add(flashLight);
  obstacleGroup.flashLight = flashLight;

  obstacleGroup.add(barMesh);
  obstacleGroup.add(glowTop);
  obstacleGroup.add(glowBottom);
  
  obstacleGroup.userData = {
    radius: 1.0,
    width: 2.0,
    depth: 0.6,
    type: 'barrier'
  };

  scene.add(obstacleGroup);
  obstacles.push(obstacleGroup);
}

function spawnShard() {
  if (gameState !== 'PLAYING') return;

  const lanes = [-LANE_WIDTH, 0, LANE_WIDTH];
  const targetLane = lanes[Math.floor(Math.random() * lanes.length)];

  const shardGeom = new THREE.OctahedronGeometry(0.55, 0);
  const shardMat = new THREE.MeshStandardMaterial({
    color: theme.accent,
    emissive: theme.accent,
    emissiveIntensity: 0.7,
    roughness: 0.1,
    metalness: 0.9,
    transparent: true,
    opacity: 0.9
  });

  const shardMesh = new THREE.Mesh(shardGeom, shardMat);
  shardMesh.position.set(targetLane, 0.85, -280);
  
  const crystalLight = new THREE.PointLight(theme.accent, 3, 10);
  crystalLight.position.set(0, 0, 0);
  shardMesh.add(crystalLight);

  shardMesh.userData = {
    radius: 0.65,
    rotSpeedY: 0.02 + Math.random() * 0.025,
    rotSpeedX: 0.012,
    type: 'shard'
  };

  scene.add(shardMesh);
  shards.push(shardMesh);
}

/* =========================================================================
   5. PARTICLE ENGINE & 3D SKID MARKS RENDERER
   ========================================================================= */

function createParticleExplosion(x, y, z, colorHex, count = 20) {
  const mat = new THREE.MeshBasicMaterial({ color: colorHex });

  for (let i = 0; i < count; i++) {
    const p = new THREE.Mesh(sharedParticleGeom, mat);
    p.position.set(x, y, z);
    
    const vx = (Math.random() - 0.5) * 11;
    const vy = Math.random() * 9 + 2;
    const vz = (Math.random() - 0.5) * 11;

    p.userData = {
      vx: vx,
      vy: vy,
      vz: vz,
      life: 1.0,
      decay: 0.025 + Math.random() * 0.03
    };

    scene.add(p);
    particles.push(p);
  }
}

/**
 * Spawns twins neon/black tire skid mark segments behind rear wheels.
 * Reuses single pre-allocated shared geometry and scales its Y index dynamically.
 */
function spawnSkidMarkSegment(scrollOffset) {
  if (gameState !== 'PLAYING' || !isDrifting) return;

  const lx = carGroup.position.x - 0.56;
  const rx = carGroup.position.x + 0.56;
  const z = carGroup.position.z + 0.85;

  // left tire skid
  const skidL = new THREE.Mesh(sharedSkidGeom, sharedSkidMat);
  skidL.rotation.x = -Math.PI / 2;
  skidL.scale.y = scrollOffset; // scale template geometry instead of allocating new geometry
  skidL.position.set(lx, 0.012, z - scrollOffset / 2);
  skidL.rotation.z = driftYawAngle;
  scene.add(skidL);
  skidMarks.push(skidL);

  // right tire skid
  const skidR = new THREE.Mesh(sharedSkidGeom, sharedSkidMat);
  skidR.rotation.x = -Math.PI / 2;
  skidR.scale.y = scrollOffset;
  skidR.position.set(rx, 0.012, z - scrollOffset / 2);
  skidR.rotation.z = driftYawAngle;
  scene.add(skidR);
  skidMarks.push(skidR);

  while (skidMarks.length > MAX_SKID_MARKS) {
    const oldest = skidMarks.shift();
    scene.remove(oldest);
  }
}

function updateSkidMarks(scrollOffset) {
  for (let i = skidMarks.length - 1; i >= 0; i--) {
    const skid = skidMarks[i];
    skid.position.z += scrollOffset; // scroll backward with road

    // Delete once past viewport behind camera
    if (skid.position.z > 15) {
      scene.remove(skid);
      skidMarks.splice(i, 1);
    }
  }
}

function emitDriftSparks() {
  if (gameState !== 'PLAYING' || !isDrifting) return;

  const emitters = [
    { x: carGroup.position.x - 0.56, z: carGroup.position.z + 0.85 },
    { x: carGroup.position.x + 0.56, z: carGroup.position.z + 0.85 }
  ];

  emitters.forEach(em => {
    // Reuse pre-allocated Spark Geometry & Material
    const p = new THREE.Mesh(sharedSparkGeom, sharedSparkMat);
    p.position.set(em.x, 0.05, em.z);
    
    p.userData = {
      vx: -slideVelocity * 0.4 + (Math.random() - 0.5) * 4.5,
      vy: Math.random() * 2.8 + 0.5,
      vz: speed * 0.11 + Math.random() * 5.0,
      life: 0.75,
      decay: 0.07 + Math.random() * 0.06
    };

    scene.add(p);
    particles.push(p);
  });
}

function updateParticles(delta) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.position.x += p.userData.vx * delta;
    p.position.y += p.userData.vy * delta;
    p.position.z += p.userData.vz * delta;

    p.userData.vy -= 9.8 * delta;
    p.userData.life -= p.userData.decay;
    p.scale.setScalar(p.userData.life);

    if (p.userData.life <= 0) {
      scene.remove(p);
      particles.splice(i, 1);
    }
  }
}

function emitExhaustSmoke() {
  if (gameState !== 'PLAYING') return;

  const exhaustY = 0.1;
  const exhaustZ = 0.75;
  const lx = carGroup.position.x - 0.42;
  const rx = carGroup.position.x + 0.42;

  // Reuse pre-allocated geometries and materials
  const mat = isBoosting ? sharedSparkMat : sharedExhaustMat;

  const pipes = [lx, rx];
  pipes.forEach(px => {
    const p = new THREE.Mesh(sharedExhaustGeom, mat);
    p.position.set(px, exhaustY, carGroup.position.z + exhaustZ);
    
    p.userData = {
      vx: (Math.random() - 0.5) * 0.6,
      vy: Math.random() * 0.8,
      vz: speed * 0.08 + Math.random() * 1.5,
      life: 0.7,
      decay: 0.05
    };

    scene.add(p);
    particles.push(p);
  });
}

/* =========================================================================
   6. CONTROLS, DOUBLE-INTEGRATION PHYSICS & SUSPENSION
   ========================================================================= */

function setupInput() {
  window.addEventListener('keydown', (e) => {
    if (e.key in keys) {
      keys[e.key] = true;
    }
    if (e.key === 'c' || e.key === 'C') {
      toggleCameraView();
    }
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
      togglePause();
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key in keys) {
      keys[e.key] = false;
    }
  });
}

function handleInput(delta) {
  if (gameState !== 'PLAYING') return;

  let steerDir = 0;
  if (keys.a || keys.ArrowLeft) steerDir = -1;
  if (keys.d || keys.ArrowRight) steerDir = +1;

  // Drift Slip state when steering above 55 KM/H
  isDrifting = (steerDir !== 0 && speed > 55);

  // 1. Steering Momentum (Double-Integration Physics Model)
  if (steerDir !== 0) {
    // F = m * a  =>  a = F / m
    carAccelerationX = steerDir * (STEER_FORCE / CAR_MASS);
  } else {
    carAccelerationX = 0;
  }

  // Lateral Friction Grip Coefficient
  // Drifting reduces lateral friction, creating a realistic sliding slide inertia
  const grip = isDrifting ? DRIFT_FRICTION : GRIP_FRICTION;
  carAccelerationX -= carVelocityX * grip;

  // Integrate Acceleration -> Velocity
  carVelocityX += carAccelerationX * delta;
  
  // Integrate Velocity -> Position
  carTargetX += carVelocityX * delta;

  // Bounds checking
  if (carTargetX > MAX_X) {
    carTargetX = MAX_X;
    carVelocityX = 0;
  } else if (carTargetX < -MAX_X) {
    carTargetX = -MAX_X;
    carVelocityX = 0;
  }
  carGroup.position.x = carTargetX;

  // Slide momentum tracks sideways velocity
  slideVelocity = Math.abs(carVelocityX);

  // Play audio screeches during drift slides
  synth.setScreechIntensity(isDrifting ? slideVelocity : 0);

  // 2. Chassis Pitch Suspension Animations (Accel squats / Braking nose dives)
  isBraking = keys.s || keys.ArrowDown;
  const isPressingGas = keys.w || keys.ArrowUp;
  
  let pitchTarget = 0.0;
  if (isBraking) {
    pitchTarget = 0.055; // dive forward
  } else if (isPressingGas && speed < currentMaxSpeed) {
    pitchTarget = -0.038; // squat back
  }

  carGroup.rotation.x = THREE.MathUtils.lerp(carGroup.rotation.x, pitchTarget, 8 * delta);

  // Yaw drift rotation (turning chassis Y axis into the slide angle)
  if (isDrifting) {
    driftYawAngle = THREE.MathUtils.lerp(driftYawAngle, -steerDir * 0.28, 12 * delta);
    // Roll tilt outwards
    carGroup.rotation.z = THREE.MathUtils.lerp(carGroup.rotation.z, -steerDir * 0.12, 10 * delta);
  } else {
    driftYawAngle = THREE.MathUtils.lerp(driftYawAngle, 0, 8 * delta);
    carGroup.rotation.z = THREE.MathUtils.lerp(carGroup.rotation.z, 0, 8 * delta);
  }
  
  carGroup.rotation.y = driftYawAngle;

  // Speed adjustments  // Forward speed calculations
  
  let accelRate = SPEED_DECEL;

  if (isBoosting) {
    targetSpeed = 260;
    accelRate = SPEED_ACCEL * 1.5;
  } else if (isBraking) {
    targetSpeed = 0;
    accelRate = BRAKE_DECEL;
  } else if (isPressingGas) {
    targetSpeed = currentMaxSpeed;
    accelRate = SPEED_ACCEL;
  } else {
    // Not pressing gas: coast to a stop
    targetSpeed = 0;
    accelRate = SPEED_DECEL;
  }

  speed = THREE.MathUtils.lerp(speed, targetSpeed, accelRate * delta);
}

/* =========================================================================
   7. CORE ENGINE LOOP & CAMERA DRIFT LAG
   ========================================================================= */

function update(time, delta) {
  // Rotate wheels
  const rotAmount = (speed * 0.12) * delta;
  carGroup.children.forEach(child => {
    if (child.name.startsWith('wheel_')) {
      child.children[0].rotation.x += rotAmount;
    }
  });

  if (gameState === 'PLAYING') {
    distance += (speed * 0.28) * delta;
    score += Math.floor((speed * 0.1) * delta * 5);
    
    document.getElementById('hud-score').innerText = String(Math.floor(score)).padStart(5, '0');
    document.getElementById('hud-speed').innerText = Math.round(speed);
    document.getElementById('speed-fill').style.width = `${Math.min(100, (speed / 300) * 100)}%`;

    // Engine sound gearbox and wind dynamics
    synth.setEnginePitchAndVolume(speed / 300, true, delta);

    if (isBoosting) {
      boostTimer -= delta;
      if (boostTimer <= 0) {
        isBoosting = false;
        speedBlurOverlay.classList.add('hidden');
        camera.fov = 60;
        camera.updateProjectionMatrix();
      }
    }

    // Scroll road texture
    const scrollV = (speed * 0.0011) * delta;
    if (roadTexture) {
      roadTexture.offset.y += scrollV;
    }

    // Spawned obstacles and shard positioning updates (bringing them closer)
    const objectMoveOffset = (speed * 0.28) * delta;
    updateObstacles(objectMoveOffset);
    updateShards(objectMoveOffset);

    // 3D Skid Mark updates
    if (isDrifting) {
      spawnSkidMarkSegment(objectMoveOffset);
      emitDriftSparks();
    }
    updateSkidMarks(objectMoveOffset);

    // Spawner timers (only spawn obstacles/shards if car is moving above 15 km/h)
    if (speed > 15 && time - lastSpawnTime > SPAWN_INTERVAL) {
      if (Math.random() < 0.6) {
        spawnObstacle();
      } else {
        spawnShard();
      }
      lastSpawnTime = time;
    }

    emitExhaustSmoke();

    // Suspension road bounce vibrations (micro vibration on Y axis)
    const roadVibration = Math.sin(time * 0.04 * speed) * (speed * 0.0001);
    carGroup.position.y = 0.28 + roadVibration;

    // Camera positioning based on current view mode
    if (cameraView === 'THIRD_PERSON') {
      const camTargetX = carGroup.position.x;
      camera.position.x = THREE.MathUtils.lerp(camera.position.x, camTargetX, 3.4 * delta);
      camera.position.y = 3.8;
      camera.position.z = 7.5;
      
      const camDriftOffset = carGroup.position.x - camera.position.x;
      camera.lookAt(carGroup.position.x * 0.6, 1.15, carGroup.position.z - 18);
      camera.rotation.z = -camDriftOffset * 0.045; // G-force roll rotation
    } else {
      // First-Person Hood Cam (stabilized Y coordinate locks to car's vertical rumble)
      camera.position.x = carGroup.position.x;
      camera.position.y = carGroup.position.y + 0.34; 
      camera.position.z = carGroup.position.z - 0.48; // shifted back slightly for better hood framing
      
      // Look straight forward down road
      camera.lookAt(carGroup.position.x, 0.45, carGroup.position.z - 25);
      
      // Dynamic head-tilt G-forces based on lateral slide velocity
      camera.rotation.z = -carVelocityX * 0.0075;

      // Update Cockpit HUD elements
      document.getElementById('cockpit-gear').innerText = synth.currentGear;
      // Convert lateral velocity to G-forces visual representation
      const gForce = Math.abs(carVelocityX * 0.045);
      document.getElementById('cockpit-gforce').innerText = `${gForce.toFixed(2)} G`;
    }
  } else {
    camera.position.x = 0;
    camera.rotation.set(0, 0, 0);
    camera.lookAt(0, 1.2, -15);
  }

  updateParticles(delta);
  applyCameraShake();
  renderer.render(scene, camera);
}

function updateObstacles(offset) {
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const obs = obstacles[i];
    obs.position.z += offset;

    if (obs.flashLight) {
      obs.flashLight.intensity = Math.sin(Date.now() * 0.02) * 2 + 2;
    }

    const distZ = Math.abs(carGroup.position.z - obs.position.z);
    const distX = Math.abs(carGroup.position.x - obs.position.x);

    if (distZ < 1.75 && distX < (obs.userData.width / 2 + 0.5)) {
      handleObstacleHit(obs);
      obstacles.splice(i, 1);
      continue;
    }

    if (obs.position.z > 15) {
      scene.remove(obs);
      obstacles.splice(i, 1);
    }
  }
}

function handleObstacleHit(obs) {
  scene.remove(obs);
  synth.playCrashSound();
  
  createParticleExplosion(obs.position.x, obs.position.y, obs.position.z, theme.primary, 25);

  shield = Math.max(0, shield - 25);
  updateShieldUI();

  shakeIntensity = 0.45;
  
  // Speed penalty: instantly drop velocity to 25% of current speed
  speed = speed * 0.25;

  const flash = document.getElementById('damage-overlay');
  flash.classList.remove('hidden');
  flash.classList.add('flash');
  setTimeout(() => {
    flash.classList.remove('flash');
    flash.classList.add('hidden');
  }, 400);

  if (shield <= 0) {
    triggerGameOver();
  }
}

function updateShards(offset) {
  for (let i = shards.length - 1; i >= 0; i--) {
    const shard = shards[i];
    shard.position.z += offset;

    shard.rotation.y += shard.userData.rotSpeedY;
    shard.rotation.x += shard.userData.rotSpeedX;
    shard.position.y = 0.95 + Math.sin(Date.now() * 0.0055) * 0.12;

    const distZ = Math.abs(carGroup.position.z - shard.position.z);
    const distX = Math.abs(carGroup.position.x - shard.position.x);

    if (distZ < 1.3 && distX < 0.9) {
      handleShardCollect(shard);
      shards.splice(i, 1);
      continue;
    }

    if (shard.position.z > 15) {
      scene.remove(shard);
      shards.splice(i, 1);
    }
  }
}

function handleShardCollect(shard) {
  scene.remove(shard);
  synth.playCollectSound();

  shardsCollected++;
  score += 1500;

  createParticleExplosion(shard.position.x, shard.position.y, shard.position.z, theme.accent, 15);

  shield = Math.min(100, shield + 10);
  updateShieldUI();

  triggerBoost();
}

function triggerBoost() {
  synth.playBoostSound();
  isBoosting = true;
  boostTimer = 3.5;
  currentMaxSpeed = Math.min(300, currentMaxSpeed + 10);

  speedBlurOverlay.classList.remove('hidden');

  camera.fov = 78;
  camera.updateProjectionMatrix();
}

function updateShieldUI() {
  const fill = document.getElementById('shield-fill');
  const txt = document.getElementById('shield-value');

  txt.innerText = shield;
  fill.style.width = `${shield}%`;

  fill.classList.remove('warning', 'danger');
  if (shield <= 25) {
    fill.classList.add('danger');
  } else if (shield <= 50) {
    fill.classList.add('warning');
  }
}

function applyCameraShake() {
  if (shakeIntensity > 0.005) {
    camera.position.x += (Math.random() - 0.5) * shakeIntensity;
    camera.position.y += (Math.random() - 0.5) * shakeIntensity;
    shakeIntensity *= shakeDecay;
  }
}

/* =========================================================================
   8. GAME STATES & TRANSITIONS
   ========================================================================= */

function triggerStart() {
  synth.init();
  
  score = 0;
  distance = 0;
  speed = 0; // Start stationary (must hold W/Up to drive)
  shield = 100;
  shardsCollected = 0;
  currentMaxSpeed = 160;
  isBoosting = false;
  boostTimer = 0;
  carTargetX = 0;
  carVelocityX = 0;
  carAccelerationX = 0;
  slideVelocity = 0;
  driftYawAngle = 0;
  isPaused = false;
  carGroup.position.set(0, 0.28, -8);
  carGroup.rotation.set(0, 0, 0);

  updateShieldUI();

  obstacles.forEach(o => scene.remove(o));
  shards.forEach(s => scene.remove(s));
  particles.forEach(p => scene.remove(p));
  skidMarks.forEach(sk => scene.remove(sk));
  obstacles = [];
  shards = [];
  particles = [];
  skidMarks = [];

  document.getElementById('start-menu').classList.add('hidden');
  document.getElementById('game-over-menu').classList.add('hidden');
  document.getElementById('pause-menu').classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('cockpit-overlay').classList.add('hidden');
  speedBlurOverlay.classList.add('hidden');

  cameraView = 'THIRD_PERSON';
  gameState = 'PLAYING';
  document.body.classList.add('playing-state');
  document.body.classList.remove('paused-state');
  lastSpawnTime = performance.now();
}

function triggerGameOver() {
  gameState = 'GAMEOVER';
  isPaused = false;
  synth.setEnginePitchAndVolume(0, false, 0);
  synth.setScreechIntensity(0);

  if (headlightsSpotlight) headlightsSpotlight.intensity = 0;

  createParticleExplosion(carGroup.position.x, carGroup.position.y, carGroup.position.z, theme.primary, 40);

  document.getElementById('hud').classList.add('hidden');
  document.getElementById('cockpit-overlay').classList.add('hidden');
  document.getElementById('pause-menu').classList.add('hidden');
  document.getElementById('game-over-menu').classList.remove('hidden');
  document.body.classList.remove('playing-state');
  document.body.classList.remove('paused-state');
  
  document.getElementById('final-score').innerText = Math.floor(score);
  document.getElementById('final-speed').innerText = `${Math.round(currentMaxSpeed)} KM/H`;
  document.getElementById('final-shards').innerText = shardsCollected;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

/* =========================================================================
   9. EVENT BINDINGS
   ========================================================================= */

function selectTheme(paletteName, btn) {
  // Remove active class from all theme buttons on both Start and Game Over menus
  document.querySelectorAll('.palette-btn').forEach(b => b.classList.remove('active'));
  
  // Highlight all buttons matching selected theme to keep menus in sync
  document.querySelectorAll(`.palette-btn[data-palette="${paletteName}"]`).forEach(b => b.classList.add('active'));
  
  selectedPalette = paletteName;
  document.body.setAttribute('data-theme', selectedPalette);
  theme = PALETTES[selectedPalette];
  
  if (scene) {
    initEngine();
  }
}
window.selectTheme = selectTheme; // Make globally accessible

const soundBtn = document.getElementById('audio-toggle');
const iconOn = document.getElementById('sound-icon-on');
const iconOff = document.getElementById('sound-icon-off');

soundBtn.addEventListener('click', () => {
  synth.init();
  const isMuted = synth.toggleMute();
  if (isMuted) {
    iconOn.classList.add('hidden');
    iconOff.classList.remove('hidden');
  } else {
    iconOn.classList.remove('hidden');
    iconOff.classList.add('hidden');
    if (gameState === 'PLAYING') {
      synth.setEnginePitchAndVolume(speed / 300, true, 0);
    }
  }
});

function toggleCameraView() {
  cameraView = (cameraView === 'THIRD_PERSON') ? 'FIRST_PERSON' : 'THIRD_PERSON';
  document.getElementById('cockpit-overlay').classList.toggle('hidden', cameraView === 'THIRD_PERSON');
}

function togglePause() {
  if (gameState !== 'PLAYING') return;
  
  isPaused = !isPaused;
  const overlay = document.getElementById('pause-menu');
  
  if (isPaused) {
    overlay.classList.remove('hidden');
    document.body.classList.add('paused-state');
    
    // Silence audio engines on pause
    synth.setEnginePitchAndVolume(0, false, 0);
    synth.setScreechIntensity(0);
  } else {
    overlay.classList.add('hidden');
    document.body.classList.remove('paused-state');
    
    // Resume audio engine hum
    synth.setEnginePitchAndVolume(speed / 300, true, 0);
  }
}

document.getElementById('view-toggle').addEventListener('click', () => {
  toggleCameraView();
});

document.getElementById('resume-btn').addEventListener('click', () => {
  togglePause();
});

document.getElementById('start-btn').addEventListener('click', () => {
  triggerStart();
});

document.getElementById('restart-btn').addEventListener('click', () => {
  triggerStart();
});

// Start Engine
initEngine();
setupInput();
window.addEventListener('resize', onWindowResize, false);

let lastTime = 0;
function tick(timestamp) {
  requestAnimationFrame(tick);
  
  if (!lastTime) lastTime = timestamp;
  const delta = Math.min((timestamp - lastTime) / 1000, 0.1);
  lastTime = timestamp;

  if (isPaused) {
    // Freeze-frame the WebGL renderer without updating physics calculations
    renderer.render(scene, camera);
    return;
  }

  handleInput(delta);
  update(timestamp, delta);
}

requestAnimationFrame(tick);
