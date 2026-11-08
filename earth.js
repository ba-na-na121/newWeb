// Shared neon-earth scene (p5.js global mode), used by index.html and password.html.
// Set window.EARTH_SHOW_HUD = true before this script loads to draw the corner info text.

let particles = [];
let earthTexture;
let rotationX = 0;
let rotationY = 0;
let rotationSpeedX = 0;
let rotationSpeedY = 0;
let zoom = 1;

// Intro: the earth starts a bit smaller and eases up to full size once the page is ready.
const INTRO_FROM = 0.6;
const INTRO_MS = 2400;
let introActive = true;
let introStart = 0;

// Fewer particles on phones so the animation stays smooth.
const PARTICLE_COUNT = Math.min(window.innerWidth, window.innerHeight) < 600 ? 400 : 800;

function preload() {
  earthTexture = loadImage('earth_lines_neon.webp');
}

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight, WEBGL);
  setupPointers(canvas.elt);
  colorMode(HSB, 360, 100, 100);
  noStroke();
  for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(new Particle());

  if (window.EARTH_SHOW_HUD) setupHud();

  // preload() has finished by the time setup() runs, so hide the loader now.
  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'none';

  zoom = INTRO_FROM;
  introStart = performance.now();
}

function draw() {
  background(0);

  if (introActive) {
    const t = Math.min(1, (performance.now() - introStart) / INTRO_MS);
    zoom = INTRO_FROM + (1 - INTRO_FROM) * (1 - Math.pow(1 - t, 3)); // ease-out
    if (t >= 1) introActive = false;
  }

  rotationY += rotationSpeedY;
  rotationX += rotationSpeedX;
  rotationSpeedX *= 0.95; // 摩擦减速
  rotationSpeedY *= 0.95;
  rotationY += 0.0005; // 每帧微小自转

  push();
  rotateX(rotationX);
  rotateY(rotationY);
  scale(zoom);
  drawEarth();
  drawParticles();
  pop();
}

function drawEarth() {
  push();
  ambientLight(50);
  directionalLight(0, 255, 255, 0, 0, -1);
  fill(200, 30, 90);
  if (earthTexture) texture(earthTexture);
  sphere(Math.min(180, Math.min(width, height) * 0.32));
  pop();
}

function drawParticles() {
  for (const p of particles) {
    p.update();
    p.show();
  }
}

// Bottom-right readout: a ticking clock and a fixed made-up location, in plain white.
// Drawn as HTML on top of the canvas (p5's WEBGL mode can't draw text without a loaded font).
let hudClock;

function setupHud() {
  const box = document.createElement('div');
  box.className = 'earth-hud';
  hudClock = document.createElement('div');
  const loc = document.createElement('div');
  loc.textContent = `LOC: ${random(20, 60).toFixed(1)}°N ${random(30, 90).toFixed(1)}°E`;
  box.append(hudClock, loc);
  document.body.append(box);
  tickClock();
  setInterval(tickClock, 1000);
}

function tickClock() {
  hudClock.textContent = `TIME: ${new Date().toLocaleTimeString()}`;
}

class Particle {
  constructor() {
    this.theta = random(TWO_PI);
    this.phi = random(TWO_PI);
    this.r = random(200, 400);
    this.speed = random(0.0005, 0.002);
    this.hue = random(360);
  }
  update() {
    this.theta += this.speed;
    this.phi += this.speed * 0.8;
  }
  show() {
    push();
    translate(
      this.r * sin(this.theta) * cos(this.phi),
      this.r * sin(this.theta) * sin(this.phi),
      this.r * cos(this.theta)
    );
    fill(this.hue, 80, 100);
    sphere(1.5);
    pop();
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// Mouse, finger and pen all go through Pointer Events: one finger (or the mouse) drags to spin the earth,
// two fingers pinch to zoom. Spinning keeps going a little after letting go.
const pointers = new Map();   // id → { x, y }
let pinchStart = null;        // { dist, zoom }

function setupPointers(el) {
  el.style.touchAction = 'none';
  const dist = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    introActive = false;
    rotationSpeedX = rotationSpeedY = 0;
    if (pointers.size === 2) pinchStart = { dist: dist(), zoom };
  });
  el.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size >= 2 && pinchStart) {
      zoom = constrain(pinchStart.zoom * dist() / pinchStart.dist, 0.5, 2.5);
    } else if (pointers.size === 1) {
      // Fingers move further than a mouse for the same intent, so touch is a bit gentler.
      const k = e.pointerType === 'touch' ? 0.004 : 0.003;
      rotationY += dx * k; rotationX += dy * k;
      rotationSpeedY = dx * k; rotationSpeedX = dy * k;
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    // After a pinch, the remaining finger shouldn't fling the earth.
    if (pointers.size === 1) rotationSpeedX = rotationSpeedY = 0;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  // Safari's own pinch-to-zoom-the-page gestures.
  ['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
}

function mouseWheel(event) {
  introActive = false; // the visitor is in control now
  zoom = constrain(zoom - event.delta * 0.001, 0.5, 2); // 限制缩放范围
  return false;
}
