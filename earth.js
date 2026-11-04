// Shared neon-earth scene (p5.js global mode), used by index.html and password.html.
// Set window.EARTH_SHOW_HUD = true before this script loads to draw the corner info text.

let particles = [];
let earthTexture;
let rotationX = 0;
let rotationY = 0;
let rotationSpeedX = 0;
let rotationSpeedY = 0;
let isDragging = false;
let prevMouseX = 0;
let prevMouseY = 0;
let timeString = '';
let locString = '';
let zoom = 1;

// Fewer particles on phones so the animation stays smooth.
const PARTICLE_COUNT = Math.min(window.innerWidth, window.innerHeight) < 600 ? 400 : 800;

function preload() {
  earthTexture = loadImage('earth_lines_neon.webp');
}

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight, WEBGL);
  canvas.mousePressed(() => {
    isDragging = true;
    prevMouseX = mouseX;
    prevMouseY = mouseY;
  });
  canvas.mouseReleased(() => (isDragging = false));
  colorMode(HSB, 360, 100, 100);
  noStroke();
  for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(new Particle());

  if (window.EARTH_SHOW_HUD) {
    setupHud();
    updateTimeAndLoc();
    setInterval(updateTimeAndLoc, 1000);
  }

  // preload() has finished by the time setup() runs, so hide the loader now.
  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'none';
}

function draw() {
  background(0);

  if (isDragging) {
    rotationSpeedY = (mouseX - prevMouseX) * 0.003;
    rotationSpeedX = (mouseY - prevMouseY) * 0.003;
    prevMouseX = mouseX;
    prevMouseY = mouseY;
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

  if (window.EARTH_SHOW_HUD) drawHud();
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

// Corner info text. Drawn as HTML on top of the canvas: p5's WEBGL mode can't draw
// text without a loaded font, which is why it never showed up before.
let hudLeft, hudRight;
function setupHud() {
  hudLeft = document.createElement('div');
  hudRight = document.createElement('div');
  hudLeft.className = 'earth-hud earth-hud-left';
  hudRight.className = 'earth-hud earth-hud-right';
  document.body.append(hudLeft, hudRight);
}

function drawHud() {
  if (frameCount % 6 !== 0) return; // DOM updates ~10x per second are plenty
  const lines = [
    'EN-US',
    `X:${Math.round(mouseX)}`,
    `Y:${Math.round(mouseY)}`,
    `ONLINE:${navigator.onLine}`,
  ];
  if (width >= 700) lines.unshift(navigator.userAgent);
  const color = () => `hsl(${Math.floor(Math.random() * 360)}, 100%, 60%)`;
  hudLeft.innerHTML = lines.map(l => `<div style="color:${color()}">${escapeHtml(l)}</div>`).join('');
  hudRight.innerHTML =
    `<div style="color:${color()}">TIME: ${timeString}</div>` +
    `<div style="color:${color()}">LOC: ${locString}</div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

function updateTimeAndLoc() {
  timeString = new Date().toLocaleTimeString();
  locString = `${random(20, 60).toFixed(1)}°N ${random(30, 90).toFixed(1)}°E`;
}

function mouseWheel(event) {
  zoom = constrain(zoom - event.delta * 0.001, 0.5, 2); // 限制缩放范围
  return false;
}
