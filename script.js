import * as THREE from 'three';

/* =========================================================================
   APEX CIRCUIT — a self-contained 3D arcade racer built on Three.js.
   Sections:
   1. Utility helpers
   2. Procedural textures
   3. Track construction (spline road, curbs, barriers, scenery)
   4. Car factory (procedural mesh) + shared physics constants
   5. Player controller (input-driven physics with drift)
   6. AI controller (spline-following opponents)
   7. Camera rig
   8. Audio (synthesized engine + impact sounds)
   9. HUD / minimap / results
   10. Game state machine & main loop
   ========================================================================= */

/* ---------------------------- 1. Utilities ---------------------------- */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return '--:--.--';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m.toString().padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};

/* ------------------------- 2. Procedural textures ---------------------- */

function makeAsphaltTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3a3d42';
  ctx.fillRect(0, 0, 128, 256);
  // speckle noise
  for (let i = 0; i < 2200; i++) {
    const x = Math.random() * 128, y = Math.random() * 256;
    const shade = Math.random() * 30 - 15;
    ctx.fillStyle = `rgba(${20 + shade + 40},${20 + shade + 40},${22 + shade + 44},${Math.random() * 0.4})`;
    ctx.fillRect(x, y, 1.6, 1.6);
  }
  // edge lines (white)
  ctx.fillStyle = '#f2f2ee';
  ctx.fillRect(6, 0, 5, 256);
  ctx.fillRect(128 - 11, 0, 5, 256);
  // dashed center line (one dash per tile)
  ctx.fillStyle = '#e8c443';
  ctx.fillRect(128 / 2 - 3, 0, 6, 120);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function makeCurbTexture() {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e63946';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = '#f2f2ee';
  ctx.fillRect(0, 0, 32, 16);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeGrassTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3d7a3a';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 6000; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const g = 90 + Math.random() * 60;
    ctx.fillStyle = `rgba(${g - 50},${g},${g - 60},0.5)`;
    ctx.fillRect(x, y, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  return tex;
}

function makeSky() {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#3a6bc9');
  grad.addColorStop(0.45, '#7fb2e0');
  grad.addColorStop(0.75, '#dff0f5');
  grad.addColorStop(1, '#f3e9d2');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* --------------------------- 3. Track construction ---------------------- */

class Track {
  constructor() {
    const pts = [
      new THREE.Vector3(0, 0, -70),
      new THREE.Vector3(48, 0, -96),
      new THREE.Vector3(98, 0, -78),
      new THREE.Vector3(118, 0, -28),
      new THREE.Vector3(94, 0, 18),
      new THREE.Vector3(96, 0, 62),
      new THREE.Vector3(56, 0, 84),
      new THREE.Vector3(10, 0, 66),
      new THREE.Vector3(-22, 0, 78),
      new THREE.Vector3(-64, 0, 68),
      new THREE.Vector3(-100, 0, 30),
      new THREE.Vector3(-108, 0, -22),
      new THREE.Vector3(-78, 0, -66),
      new THREE.Vector3(-34, 0, -84),
    ];
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.55);
    this.halfWidth = 9;
    this.barrierOffset = this.halfWidth + 1.6;
    this.segments = 400;

    this.samples = [];
    for (let i = 0; i <= this.segments; i++) {
      const u = i / this.segments;
      const p = this.curve.getPointAt(u);
      const tangent = this.curve.getTangentAt(u).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      this.samples.push({ p, tangent, normal, u });
    }

    this.group = new THREE.Group();
    this._buildRoad();
    this._buildCurbs();
    this._buildBarriers();
    this._buildStartLine();
    this._buildScenery();
  }

  _buildRoad() {
    const N = this.segments;
    const positions = [], uvs = [], indices = [];
    const lengthRepeat = 60;
    for (let i = 0; i <= N; i++) {
      const s = this.samples[i];
      const left = s.p.clone().add(s.normal.clone().multiplyScalar(this.halfWidth));
      const right = s.p.clone().add(s.normal.clone().multiplyScalar(-this.halfWidth));
      positions.push(left.x, 0.02, left.z, right.x, 0.02, right.z);
      const v = (i / N) * lengthRepeat;
      uvs.push(0, v, 1, v);
      if (i < N) {
        const a = i * 2, b = i * 2 + 1, cI = i * 2 + 2, d = i * 2 + 3;
        indices.push(a, cI, b, b, cI, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ map: makeAsphaltTexture(), roughness: 0.95, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildCurbRibbon(side, width) {
    const N = this.segments;
    const positions = [], uvs = [], indices = [];
    for (let i = 0; i <= N; i++) {
      const s = this.samples[i];
      const base = s.p.clone().add(s.normal.clone().multiplyScalar(side * this.halfWidth));
      const outer = base.clone().add(s.normal.clone().multiplyScalar(side * width));
      positions.push(base.x, 0.04, base.z, outer.x, 0.04, outer.z);
      const v = i * 0.6;
      uvs.push(0, v, 1, v);
      if (i < N) {
        const a = i * 2, b = i * 2 + 1, cI = i * 2 + 2, d = i * 2 + 3;
        indices.push(a, cI, b, b, cI, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ map: makeCurbTexture(), roughness: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildCurbs() {
    this._buildCurbRibbon(1, 1.4);
    this._buildCurbRibbon(-1, 1.4);
  }

  _buildBarriers() {
    const postGeo = new THREE.BoxGeometry(1.6, 1.1, 0.5);
    const matA = new THREE.MeshStandardMaterial({ color: 0xe6e6e6, roughness: 0.6 });
    const matB = new THREE.MeshStandardMaterial({ color: 0xd6303f, roughness: 0.6 });
    const count = 220;
    const instA = new THREE.InstancedMesh(postGeo, matA, Math.ceil(count / 2) + 2);
    const instB = new THREE.InstancedMesh(postGeo, matB, Math.ceil(count / 2) + 2);
    instA.castShadow = true; instB.castShadow = true;
    let ai = 0, bi = 0;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const u = i / count;
      const s = this.curve.getPointAt(u);
      const tangent = this.curve.getTangentAt(u).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      for (const side of [1, -1]) {
        const pos = s.clone().add(normal.clone().multiplyScalar(side * this.barrierOffset));
        dummy.position.set(pos.x, 0.55, pos.z);
        dummy.rotation.y = Math.atan2(tangent.x, tangent.z);
        dummy.updateMatrix();
        if (i % 2 === 0) instA.setMatrixAt(ai++, dummy.matrix);
        else instB.setMatrixAt(bi++, dummy.matrix);
      }
    }
    instA.count = ai; instB.count = bi;
    instA.instanceMatrix.needsUpdate = true;
    instB.instanceMatrix.needsUpdate = true;
    this.group.add(instA, instB);
  }

  _buildStartLine() {
    const u = 0;
    const s = this.curve.getPointAt(u);
    const tangent = this.curve.getTangentAt(u).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const c = document.createElement('canvas');
    c.width = 64; c.height = 16;
    const ctx = c.getContext('2d');
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 2; y++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#111' : '#f5f5f5';
        ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    const geo = new THREE.PlaneGeometry(this.halfWidth * 2, 3.2);
    const mat = new THREE.MeshStandardMaterial({ map: tex });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = -Math.atan2(tangent.x, tangent.z);
    mesh.position.set(s.x, 0.05, s.z);
    this.group.add(mesh);

    // start/finish gantry
    const gantryMat = new THREE.MeshStandardMaterial({ color: 0x22262e, metalness: 0.4, roughness: 0.5 });
    const legGeo = new THREE.CylinderGeometry(0.35, 0.35, 8, 8);
    for (const side of [1, -1]) {
      const p = s.clone().add(normal.clone().multiplyScalar(side * (this.halfWidth + 2)));
      const leg = new THREE.Mesh(legGeo, gantryMat);
      leg.position.set(p.x, 4, p.z);
      leg.castShadow = true;
      this.group.add(leg);
    }
    const barGeo = new THREE.BoxGeometry(this.halfWidth * 2 + 4.5, 1.2, 0.6);
    const bar = new THREE.Mesh(barGeo, gantryMat);
    bar.position.set(s.x, 8, s.z);
    bar.rotation.y = Math.atan2(tangent.x, tangent.z);
    bar.castShadow = true;
    this.group.add(bar);
  }

  _buildScenery() {
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.32, 2.2, 6);
    const leafGeo = new THREE.ConeGeometry(1.5, 3.4, 7);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b3a24, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f6b3a, roughness: 0.9 });
    const treeCount = 160;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, treeCount);
    trunks.castShadow = true; leaves.castShadow = true;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < treeCount; i++) {
      const u = Math.random();
      const s = this.curve.getPointAt(u);
      const tangent = this.curve.getTangentAt(u).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      const side = Math.random() < 0.5 ? 1 : -1;
      const dist = this.barrierOffset + 6 + Math.random() * 22;
      const pos = s.clone().add(normal.clone().multiplyScalar(side * dist));
      dummy.position.set(pos.x, 1.1, pos.z);
      dummy.scale.setScalar(0.8 + Math.random() * 0.7);
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      dummy.position.y = 2.6 * dummy.scale.x;
      dummy.updateMatrix();
      leaves.setMatrixAt(i, dummy.matrix);
    }
    trunks.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    this.group.add(trunks, leaves);

    // grandstand near the start line
    const standMat = new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.7 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xd6303f, roughness: 0.6 });
    const standGeo = new THREE.BoxGeometry(30, 6, 8);
    const stand = new THREE.Mesh(standGeo, standMat);
    const su = 0.02;
    const sp = this.curve.getPointAt(su);
    const st = this.curve.getTangentAt(su).normalize();
    const sn = new THREE.Vector3(-st.z, 0, st.x).normalize();
    const standPos = sp.clone().add(sn.clone().multiplyScalar(this.barrierOffset + 14));
    stand.position.set(standPos.x, 3, standPos.z);
    stand.rotation.y = Math.atan2(st.x, st.z);
    stand.castShadow = true; stand.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(31, 0.6, 9), roofMat);
    roof.position.set(standPos.x, 6.3, standPos.z);
    roof.rotation.y = stand.rotation.y;
    this.group.add(stand, roof);
  }

  // Nearest sample to a world position -> { u, lateral, normal, tangent }
  nearest(pos) {
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < this.samples.length; i += 1) {
      const s = this.samples[i];
      const dx = s.p.x - pos.x, dz = s.p.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    const s = this.samples[bestI];
    const rel = new THREE.Vector3(pos.x - s.p.x, 0, pos.z - s.p.z);
    const lateral = rel.dot(s.normal);
    return { u: s.u, lateral, normal: s.normal, tangent: s.tangent, point: s.p, index: bestI };
  }
}

/* --------------------------- 4. Car factory ---------------------------- */

const PHYSICS = {
  ACCEL: 24,
  BRAKE: 40,
  REVERSE_ACCEL: 13,
  NATURAL_DECEL: 7,
  MAX_SPEED: 44,
  MAX_REVERSE: -12,
  MAX_STEER: 0.5,
  STEER_RATE: 3.4,
  STEER_RETURN: 4.2,
  TURN_STRENGTH: 2.6,
  GRIP: 10,
  DRIFT_GRIP: 1.6,
  DRIFT_KICK: 0.9,
};

function buildCarMesh(color, isPlayer) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.35 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0.3, roughness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1b2531, metalness: 0.8, roughness: 0.15 });
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xfff4d6, emissiveIntensity: 1.4 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x990000, emissive: 0xff0000, emissiveIntensity: 0.8 });

  const lowerBody = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.5, 4.2), bodyMat);
  lowerBody.position.y = 0.5;
  const upperBody = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.4), bodyMat);
  upperBody.position.set(0, 0.95, -0.15);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.42, 1.7), glassMat);
  cabin.position.set(0, 1.18, -0.1);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.35, 0.9), darkMat);
  nose.position.set(0, 0.42, 2.1);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 0.4), darkMat);
  spoiler.position.set(0, 1.05, -2.05);
  const spoilerL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.4), darkMat);
  spoilerL.position.set(-0.75, 0.85, -2.05);
  const spoilerR = spoilerL.clone(); spoilerR.position.x = 0.75;

  [lowerBody, upperBody, nose].forEach(m => { m.castShadow = true; m.receiveShadow = true; });
  group.add(lowerBody, upperBody, cabin, nose, spoiler, spoilerL, spoilerR);

  const headlightGeo = new THREE.BoxGeometry(0.28, 0.16, 0.1);
  for (const side of [-1, 1]) {
    const hl = new THREE.Mesh(headlightGeo, lightMat);
    hl.position.set(side * 0.62, 0.5, 2.55);
    group.add(hl);
    const tl = new THREE.Mesh(headlightGeo, tailMat);
    tl.position.set(side * 0.62, 0.55, -2.25);
    group.add(tl);
  }

  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 16);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 0.8, roughness: 0.3 });
  const wheels = [];
  const wheelPositions = [
    [-0.95, 0.42, 1.35], [0.95, 0.42, 1.35],
    [-0.95, 0.42, -1.35], [0.95, 0.42, -1.35],
  ];
  for (const [x, y, z] of wheelPositions) {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(wheelGeo, wheelMat);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.34, 12), rimMat);
    rim.rotation.z = Math.PI / 2;
    w.add(tire, rim);
    w.position.set(x, y, z);
    group.add(w);
    wheels.push(w);
  }

  if (isPlayer) {
    const flame = new THREE.PointLight(0xffcc66, 0, 6, 2);
    flame.position.set(0, 0.5, -2.3);
    group.add(flame);
    group.userData.brakeLight = flame;
  }

  group.userData.wheels = wheels;
  group.userData.frontWheels = [wheels[0], wheels[1]];
  group.castShadow = true;
  return group;
}

/* Shared kinematic step used by both player and AI for a believable slide. */
function stepCarPhysics(state, throttle, brake, steerInput, handbrake, dt) {
  // Steering angle smoothing
  const targetSteer = steerInput * PHYSICS.MAX_STEER;
  const rate = steerInput !== 0 ? PHYSICS.STEER_RATE : PHYSICS.STEER_RETURN;
  state.steer = damp(state.steer, targetSteer, rate, dt);

  // Longitudinal speed (forward component)
  let forwardSpeed = state.forwardSpeed || 0;
  if (throttle > 0) {
    forwardSpeed += PHYSICS.ACCEL * throttle * dt;
  } else if (brake > 0) {
    if (forwardSpeed > 0.5) forwardSpeed -= PHYSICS.BRAKE * brake * dt;
    else forwardSpeed -= PHYSICS.REVERSE_ACCEL * brake * dt;
  } else {
    forwardSpeed -= Math.sign(forwardSpeed) * PHYSICS.NATURAL_DECEL * dt;
    if (Math.abs(forwardSpeed) < 0.15) forwardSpeed = 0;
  }
  forwardSpeed = clamp(forwardSpeed, PHYSICS.MAX_REVERSE, PHYSICS.MAX_SPEED);
  state.forwardSpeed = forwardSpeed;

  const speedFactor = clamp(Math.abs(forwardSpeed) / 6, 0, 1);
  const dir = forwardSpeed >= 0 ? 1 : -1;
  const yawRate = state.steer * PHYSICS.TURN_STRENGTH * speedFactor * dir;
  state.heading += yawRate * dt;

  const forward = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
  const right = new THREE.Vector3(forward.z, 0, -forward.x);

  if (!state.velocity) state.velocity = new THREE.Vector3();
  let fComp = state.velocity.dot(forward);
  let lComp = state.velocity.dot(right);

  fComp = forwardSpeed;
  const grip = handbrake ? PHYSICS.DRIFT_GRIP : PHYSICS.GRIP;
  lComp = damp(lComp, 0, grip, dt);
  if (handbrake) {
    lComp += state.steer * Math.abs(forwardSpeed) * PHYSICS.DRIFT_KICK * dt;
  }

  state.velocity.copy(forward).multiplyScalar(fComp).addScaledVector(right, lComp);
  state.drifting = handbrake && Math.abs(lComp) > 1.2;
  state.lateralSpeed = lComp;

  state.position.addScaledVector(state.velocity, dt);
}

/* --------------------------- 5. Player controller ----------------------- */

class PlayerCar {
  constructor(scene, track, color) {
    this.track = track;
    this.mesh = buildCarMesh(color, true);
    scene.add(this.mesh);
    const start = track.curve.getPointAt(0.0);
    const startTangent = track.curve.getTangentAt(0.0).normalize();
    this.state = {
      position: new THREE.Vector3(start.x - 4, 0, start.z),
      heading: Math.atan2(startTangent.x, startTangent.z),
      steer: 0,
      forwardSpeed: 0,
      velocity: new THREE.Vector3(),
    };
    this.lap = 0;
    this.lastU = 0;
    this.lapStart = 0;
    this.bestLap = Infinity;
    this.lapTimes = [];
    this.finished = false;
    this.finishProgress = 0;
    this.wheelSpin = 0;
    this.offTrackFlashTimer = 0;
  }

  update(dt, input, raceTime) {
    if (this.finished) { dt = 0; }
    const throttle = input.forward ? 1 : 0;
    const brake = input.back ? 1 : 0;
    const steerInput = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    stepCarPhysics(this.state, throttle, brake, steerInput, input.handbrake, dt);

    // Track boundary collision
    const n = this.track.nearest(this.state.position);
    const limit = this.track.halfWidth - 0.6;
    let collided = false;
    if (Math.abs(n.lateral) > limit) {
      collided = true;
      const over = Math.abs(n.lateral) - limit;
      const sign = Math.sign(n.lateral);
      this.state.position.addScaledVector(n.normal, -sign * over);
      this.state.forwardSpeed *= 0.86;
      this.state.velocity.multiplyScalar(0.7);
    }
    this.offTrackFlashTimer = collided ? 0.15 : Math.max(0, this.offTrackFlashTimer - dt);

    // Lap tracking
    if (!this.finished) {
      if (this.lastU > 0.8 && n.u < 0.2) {
        const lapTime = raceTime - this.lapStart;
        this.lapTimes.push(lapTime);
        if (lapTime < this.bestLap) this.bestLap = lapTime;
        this.lapStart = raceTime;
        this.lap += 1;
        if (this.lap >= 3) {
          this.finished = true;
        }
      }
      this.lastU = n.u;
    }
    this.progress = this.lap + n.u;

    // Apply transform
    this.mesh.position.copy(this.state.position);
    this.mesh.position.y = 0;
    this.mesh.rotation.y = this.state.heading;
    const tiltTarget = clamp(-this.state.lateralSpeed * 0.02, -0.18, 0.18);
    this.mesh.rotation.z = damp(this.mesh.rotation.z, tiltTarget, 6, dt || 0.016);

    // Wheel spin + steer visual
    this.wheelSpin += (this.state.forwardSpeed || 0) * dt * 2.2;
    for (const w of this.mesh.userData.wheels) w.rotation.x = this.wheelSpin;
    for (const w of this.mesh.userData.frontWheels) w.rotation.y = this.state.steer * 1.4;

    if (this.mesh.userData.brakeLight) {
      this.mesh.userData.brakeLight.intensity = brake > 0 && this.state.forwardSpeed > 0 ? 2.2 : 0;
    }
  }

  get speedKmh() { return Math.abs(this.state.forwardSpeed) * 3.6; }
}

/* ----------------------------- 6. AI controller -------------------------- */

class AICar {
  constructor(scene, track, color, skill, offsetSeed) {
    this.track = track;
    this.mesh = buildCarMesh(color, false);
    scene.add(this.mesh);
    this.t = -0.02 * offsetSeed;
    if (this.t < 0) this.t += 1;
    this.speed = 0;
    this.targetSpeed = PHYSICS.MAX_SPEED * skill;
    this.lateralOffset = (offsetSeed % 2 === 0 ? 1 : -1) * (2 + offsetSeed * 0.6);
    this.wanderPhase = Math.random() * Math.PI * 2;
    this.lap = 0;
    this.lastT = this.t;
    this.lapStart = 0;
    this.finished = false;
    this.wheelSpin = 0;
    this.position = new THREE.Vector3();
    this.heading = 0;
  }

  update(dt, raceTime) {
    if (this.finished) return;
    // gentle speed variation for realism (drafting/AI mistakes)
    this.wanderPhase += dt * 0.4;
    const wobble = Math.sin(this.wanderPhase) * 1.3;
    this.speed = damp(this.speed, this.targetSpeed + wobble, 1.5, dt);

    const arcLength = this.track.curve.getLength();
    const du = (this.speed * dt) / arcLength;
    this.t += du;
    if (this.t >= 1) {
      this.t -= 1;
      this.lap += 1;
      if (this.lap >= 3) this.finished = true;
    }

    const p = this.track.curve.getPointAt(this.t);
    const tangent = this.track.curve.getTangentAt(this.t).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const lateral = this.lateralOffset + Math.sin(this.wanderPhase * 1.7) * 1.2;
    this.position.copy(p).addScaledVector(normal, lateral);
    this.heading = Math.atan2(tangent.x, tangent.z);

    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.heading;
    this.wheelSpin += this.speed * dt * 2.2;
    for (const w of this.mesh.userData.wheels) w.rotation.x = this.wheelSpin;

    this.progress = this.lap + this.t;
  }

  get speedKmh() { return this.speed * 3.6; }
}

/* ------------------------------ 7. Camera rig ---------------------------- */

class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.initialized = false;
  }
  update(target, dt) {
    const forward = new THREE.Vector3(Math.sin(target.state.heading), 0, Math.cos(target.state.heading));
    const speedF = clamp(Math.abs(target.state.forwardSpeed) / PHYSICS.MAX_SPEED, 0, 1);
    const dist = lerp(6.4, 8.4, speedF);
    const height = lerp(2.6, 3.1, speedF);
    const desired = target.state.position.clone()
      .addScaledVector(forward, -dist)
      .add(new THREE.Vector3(0, height, 0));
    const lookTarget = target.state.position.clone()
      .addScaledVector(forward, 6)
      .add(new THREE.Vector3(0, 1.1, 0));

    if (!this.initialized) {
      this.pos.copy(desired);
      this.lookAt.copy(lookTarget);
      this.initialized = true;
    } else {
      this.pos.x = damp(this.pos.x, desired.x, 5, dt);
      this.pos.y = damp(this.pos.y, desired.y, 5, dt);
      this.pos.z = damp(this.pos.z, desired.z, 5, dt);
      this.lookAt.x = damp(this.lookAt.x, lookTarget.x, 8, dt);
      this.lookAt.y = damp(this.lookAt.y, lookTarget.y, 8, dt);
      this.lookAt.z = damp(this.lookAt.z, lookTarget.z, 8, dt);
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.lookAt);
    this.camera.fov = lerp(58, 68, speedF);
    this.camera.updateProjectionMatrix();
  }
}

/* --------------------------------- 8. Audio ------------------------------ */

class EngineAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }
  start() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.ctx.destination);

    this.osc = this.ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 400;
    this.oscGain = this.ctx.createGain();
    this.oscGain.gain.value = 0.5;
    this.osc.connect(this.filter).connect(this.oscGain).connect(this.master);
    this.osc.frequency.value = 60;
    this.osc.start();

    this.osc2 = this.ctx.createOscillator();
    this.osc2.type = 'square';
    this.osc2Gain = this.ctx.createGain();
    this.osc2Gain.gain.value = 0.12;
    this.osc2.connect(this.osc2Gain).connect(this.master);
    this.osc2.frequency.value = 120;
    this.osc2.start();
  }
  setSpeed(speedFrac) {
    if (!this.ctx) return;
    const f = 55 + speedFrac * 260;
    this.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
    this.osc2.frequency.setTargetAtTime(f * 2.01, this.ctx.currentTime, 0.05);
    this.filter.frequency.setTargetAtTime(300 + speedFrac * 2200, this.ctx.currentTime, 0.05);
  }
  impact() {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    if (this._lastImpact && now - this._lastImpact < 0.25) return;
    this._lastImpact = now;
    const bufferSize = this.ctx.sampleRate * 0.15;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = 0.35;
    src.connect(g).connect(this.master);
    src.start();
  }
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.22;
    return this.muted;
  }
  countdownBeep(high) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.value = high ? 880 : 520;
    g.gain.value = 0.25;
    o.connect(g).connect(this.master);
    const now = this.ctx.currentTime;
    g.gain.setValueAtTime(0.25, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    o.start(now);
    o.stop(now + 0.3);
  }
}

/* --------------------------- 9. HUD / minimap ---------------------------- */

class HUD {
  constructor(track) {
    this.track = track;
    this.el = {
      hud: document.getElementById('hud'),
      position: document.getElementById('hud-position'),
      lap: document.getElementById('hud-lap'),
      time: document.getElementById('hud-time'),
      best: document.getElementById('hud-best'),
      speedValue: document.getElementById('speed-value'),
      speedoFill: document.getElementById('speedo-fill'),
      gear: document.getElementById('gear-indicator'),
      minimap: document.getElementById('minimap'),
    };
    this.mmCtx = this.el.minimap.getContext('2d');
    this._computeMinimapBounds();
  }

  _computeMinimapBounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of this.track.samples) {
      minX = Math.min(minX, s.p.x); maxX = Math.max(maxX, s.p.x);
      minZ = Math.min(minZ, s.p.z); maxZ = Math.max(maxZ, s.p.z);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  _mmProject(x, z, size, pad) {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const sx = pad + ((x - minX) / (maxX - minX)) * (size - pad * 2);
    const sy = pad + ((z - minZ) / (maxZ - minZ)) * (size - pad * 2);
    return [sx, sy];
  }

  drawMinimap(player, aiCars) {
    const ctx = this.mmCtx;
    const size = this.el.minimap.width;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    this.track.samples.forEach((s, i) => {
      const [x, y] = this._mmProject(s.p.x, s.p.z, size, 14);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();

    for (const ai of aiCars) {
      const [x, y] = this._mmProject(ai.position.x, ai.position.z, size, 14);
      ctx.fillStyle = '#f4a261';
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
    const [px, py] = this._mmProject(player.state.position.x, player.state.position.z, size, 14);
    ctx.fillStyle = '#34e6c8';
    ctx.beginPath(); ctx.arc(px, py, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0a0e14'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  update(player, aiCars, raceTime, position) {
    const ord = ['1', '2', '3', '4'];
    const suf = ['st', 'nd', 'rd', 'th'];
    this.el.position.innerHTML = `${ord[position - 1]}<span>${suf[position - 1]}</span>`;
    this.el.lap.textContent = `LAP ${Math.min(player.lap + 1, 3)} / 3`;
    this.el.time.textContent = fmtTime(raceTime);
    this.el.best.textContent = isFinite(player.bestLap) ? fmtTime(player.bestLap) : '--:--.--';

    const kmh = player.speedKmh;
    this.el.speedValue.textContent = Math.round(kmh);
    const frac = clamp(kmh / (PHYSICS.MAX_SPEED * 3.6), 0, 1);
    const dash = 251;
    this.el.speedoFill.style.strokeDashoffset = (dash * (1 - frac)).toFixed(1);
    const hue = lerp(160, 0, frac);
    this.el.speedoFill.style.stroke = `hsl(${hue}, 85%, 55%)`;
    this.el.gear.textContent = player.state.forwardSpeed < -0.2 ? 'R' : 'D';

    this.drawMinimap(player, aiCars);
  }
}

/* ------------------------- 10. Game state machine ------------------------ */

class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xbfe0f0);
    this.scene.fog = new THREE.Fog(0xbfe0f0, 90, 320);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 600);
    this.chaseCam = new ChaseCamera(this.camera);

    this.input = { forward: false, back: false, left: false, right: false, handbrake: false };
    this.audio = new EngineAudio();
    this.playerColor = '#e63946';

    this.state = 'loading';
    this.raceTime = 0;
    this.countdownValue = 3;

    this._buildLights();
    this._buildSky();
    this._buildGround();

    window.addEventListener('resize', () => this._onResize());
    this._onResize();
    this._bindMenu();
    this._bindKeyboard();
    this._bindTouch();

    this._loadSequence();
  }

  _loadSequence() {
    const fill = document.getElementById('loader-bar-fill');
    const status = document.getElementById('loader-status');
    const steps = [
      ['Generating raceway…', 20],
      ['Building scenery…', 45],
      ['Assembling vehicles…', 70],
      ['Priming engines…', 90],
      ['Ready.', 100],
    ];
    let i = 0;
    const doStep = () => {
      if (i === 0) {
        this.track = new Track();
        this.scene.add(this.track.group);
      }
      const [msg, pct] = steps[i];
      status.textContent = msg;
      fill.style.width = pct + '%';
      i++;
      if (i < steps.length) {
        setTimeout(doStep, 180);
      } else {
        setTimeout(() => {
          document.getElementById('loading-screen').classList.add('hidden');
          document.getElementById('menu-screen').classList.remove('hidden');
          if (window.matchMedia('(pointer: coarse)').matches) {
            document.getElementById('touch-controls').classList.remove('hidden');
          }
          this.state = 'menu';
          this._renderStatic();
        }, 200);
      }
    };
    doStep();
  }

  _renderStatic() {
    // Show a nice frame behind the menu before the race starts
    this.camera.position.set(0, 22, 40);
    this.camera.lookAt(0, 0, -20);
    this.renderer.render(this.scene, this.camera);
    this._menuSpin = requestAnimationFrame((t) => this._menuLoop(t));
  }

  _menuLoop(t) {
    if (this.state !== 'loading' && this.state !== 'menu') return;
    const a = t * 0.00008;
    this.camera.position.set(Math.sin(a) * 55, 26, Math.cos(a) * 55);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
    this._menuSpin = requestAnimationFrame((tt) => this._menuLoop(tt));
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xbfe0f0, 0x3d5a2a, 0.75);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3d6, 1.35);
    sun.position.set(120, 160, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -160;
    sun.shadow.camera.right = 160;
    sun.shadow.camera.top = 160;
    sun.shadow.camera.bottom = -160;
    sun.shadow.camera.far = 400;
    sun.shadow.bias = -0.0015;
    this.scene.add(sun);
    this.scene.add(sun.target);
  }

  _buildSky() {
    const geo = new THREE.SphereGeometry(400, 24, 16);
    const mat = new THREE.MeshBasicMaterial({ map: makeSky(), side: THREE.BackSide, fog: false });
    const sky = new THREE.Mesh(geo, mat);
    this.scene.add(sky);
  }

  _buildGround() {
    const geo = new THREE.PlaneGeometry(1400, 1400);
    const mat = new THREE.MeshStandardMaterial({ map: makeGrassTexture(), roughness: 1 });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  _spawnCars() {
    this.player = new PlayerCar(this.scene, this.track, this.playerColor);
    const aiColors = [0x457b9d, 0xf4a261, 0x9d4edd];
    const skills = [0.9, 0.86, 0.93];
    this.aiCars = aiColors.map((c, i) => new AICar(this.scene, this.track, c, skills[i], i + 1));
  }

  _bindMenu() {
    const swatches = document.querySelectorAll('.swatch');
    swatches.forEach((sw, idx) => {
      sw.addEventListener('click', () => {
        swatches.forEach(s => s.classList.remove('selected'));
        sw.classList.add('selected');
        this.playerColor = sw.dataset.color;
        if (this.player) {
          this.player.mesh.children.forEach(c => {
            if (c.material && c.material.metalness === 0.55) c.material.color.set(this.playerColor);
          });
        }
      });
      if (idx === 0) sw.classList.add('selected');
    });

    document.getElementById('start-btn').addEventListener('click', () => this._startRace());
    document.getElementById('restart-btn').addEventListener('click', () => this._restart());
    document.getElementById('mute-btn').addEventListener('click', (e) => {
      const muted = this.audio.toggleMute();
      e.target.textContent = muted ? '🔇' : '🔊';
    });
  }

  _bindKeyboard() {
    const map = {
      KeyW: 'forward', ArrowUp: 'forward',
      KeyS: 'back', ArrowDown: 'back',
      KeyA: 'left', ArrowLeft: 'left',
      KeyD: 'right', ArrowRight: 'right',
      Space: 'handbrake',
    };
    window.addEventListener('keydown', (e) => {
      if (map[e.code]) { this.input[map[e.code]] = true; e.preventDefault(); }
      if (e.code === 'KeyR' && this.state === 'racing') this._resetOnTrack();
    });
    window.addEventListener('keyup', (e) => {
      if (map[e.code]) { this.input[map[e.code]] = false; }
    });
  }

  _bindTouch() {
    const bind = (id, key) => {
      const el = document.getElementById(id);
      const on = (e) => { e.preventDefault(); this.input[key] = true; };
      const off = (e) => { e.preventDefault(); this.input[key] = false; };
      el.addEventListener('pointerdown', on);
      el.addEventListener('pointerup', off);
      el.addEventListener('pointerleave', off);
      el.addEventListener('pointercancel', off);
    };
    bind('touch-gas', 'forward');
    bind('touch-brake', 'back');
    bind('touch-left', 'left');
    bind('touch-right', 'right');
    bind('touch-drift', 'handbrake');
  }

  _resetOnTrack() {
    const n = this.track.nearest(this.player.state.position);
    this.player.state.position.copy(n.point);
    this.player.state.heading = Math.atan2(n.tangent.x, n.tangent.z);
    this.player.state.forwardSpeed = 0;
    this.player.state.velocity.set(0, 0, 0);
  }

  _startRace() {
    document.getElementById('menu-screen').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    this.audio.start();
    this._spawnCars();
    // recolor player body to chosen swatch
    this.player.mesh.children.forEach(c => {
      if (c.material && c.material.metalness === 0.55) c.material.color.set(this.playerColor);
    });
    this.hud = new HUD(this.track);
    this.raceTime = 0;
    this._runCountdown();
  }

  _runCountdown() {
    this.state = 'countdown';
    const el = document.getElementById('countdown');
    el.classList.remove('hidden');
    this.chaseCam.initialized = false;
    const preRender = () => {
      if (this.state !== 'countdown') return;
      this.chaseCam.update(this.player, 0.016);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(preRender);
    };
    preRender();

    const seq = ['3', '2', '1', 'GO!'];
    let i = 0;
    const step = () => {
      el.innerHTML = `<span>${seq[i]}</span>`;
      this.audio.countdownBeep(i === seq.length - 1);
      i++;
      if (i < seq.length) {
        setTimeout(step, 800);
      } else {
        setTimeout(() => {
          el.classList.add('hidden');
          this.state = 'racing';
          this.lastFrame = performance.now();
          this._loop();
        }, 700);
      }
    };
    step();
  }

  _loop() {
    if (this.state !== 'racing') return;
    const now = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    dt = Math.min(dt, 0.05);
    this.lastFrame = now;
    this.raceTime += dt;

    this.player.update(dt, this.input, this.raceTime);
    for (const ai of this.aiCars) ai.update(dt, this.raceTime);

    if (this.player.offTrackFlashTimer > 0.001) this.audio.impact();

    this.chaseCam.update(this.player, dt);

    const speedFrac = clamp(Math.abs(this.player.state.forwardSpeed) / PHYSICS.MAX_SPEED, 0, 1);
    this.audio.setSpeed(speedFrac);

    // Ranking
    const all = [{ ref: this.player, progress: this.player.progress }, ...this.aiCars.map(a => ({ ref: a, progress: a.progress }))];
    all.sort((a, b) => b.progress - a.progress);
    const position = all.findIndex(a => a.ref === this.player) + 1;

    this.hud.update(this.player, this.aiCars, this.raceTime, position);

    this.renderer.render(this.scene, this.camera);

    if (this.player.finished) {
      this._showResults(position);
      return;
    }

    requestAnimationFrame(() => this._loop());
  }

  _showResults(position) {
    this.state = 'finished';
    document.getElementById('hud').classList.add('hidden');
    const screen = document.getElementById('results-screen');
    const table = document.getElementById('results-table');
    document.getElementById('results-heading').textContent = position === 1 ? 'VICTORY!' : 'RACE COMPLETE';

    const rows = [{ name: 'YOU', progress: this.player.progress, isPlayer: true, time: this.raceTime }];
    this.aiCars.forEach((a, i) => rows.push({ name: `RIVAL ${i + 1}`, progress: a.progress, isPlayer: false }));
    rows.sort((a, b) => b.progress - a.progress);

    table.innerHTML = rows.map((r, i) => `
      <div class="results-row ${r.isPlayer ? 'player' : ''}">
        <span class="rpos">${i + 1}</span>
        <span>${r.name}</span>
        <span>${r.time ? fmtTime(r.time) : (r.progress >= 3 ? 'Finished' : `Lap ${Math.floor(r.progress) + 1}`)}</span>
      </div>
    `).join('');

    screen.classList.remove('hidden');
  }

  _restart() {
    document.getElementById('results-screen').classList.add('hidden');
    document.getElementById('menu-screen').classList.remove('hidden');
    // remove old cars
    this.scene.remove(this.player.mesh);
    for (const ai of this.aiCars) this.scene.remove(ai.mesh);
    this.state = 'menu';
    this._menuLoop(performance.now());
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

new Game();

