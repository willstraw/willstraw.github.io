// Fusion-style 3D viewer: spinning model on a fading grid, with drag-to-rotate, scroll/pinch zoom and a ViewCube.
// It is a plain script (not a module) so pages still work when opened straight from disk.
// Include viewer.css and <script src="viewer.js">, then from the page's module script:
//
//   createViewer(THREE, sectionElement, {
//     load: async ({ setStatus }) => ({
//       model,        // THREE.Object3D, already centred on the origin
//       radius,       // bounding-sphere radius, used for near/far planes
//       floorY,       // where the grid sits (just under the model)
//       grid: { size, minor, major },
//       fit,          // (vFovRadians, aspect) => camera distance that shows the whole model
//     }),
//   });
//
// Options: staticOnPhones (see below) and wheelZoom: false, which leaves the scroll wheel to scroll the page.
// createViewer returns a small API so a page can steer the view itself, for example from the scroll position:
//   setFrame(rect)        centre and fit the model in { x, y, width, height } (CSS px within the section), or null for all of it
//   setPose({ blend, x, y, fov })   blend 0..1 from the free (dragged or spinning) view toward a fixed rotation and field of view
//   setGridOpacity(a)     fade the grid, 0..1
//   project(vector3)      where a point on the model appears, in CSS px within the section

(() => {
  const AUTO_SPEED = 25;      // idle spin in degrees per second
  const IDLE_MS = 2000;       // wait this long after interacting before auto-spinning again
  const HOME_TILT = -15;      // default view looks slightly down onto the grid
  const HOME_TURN = -30;
  const MIN_ZOOM = 0.1;       // closest the scroll wheel can zoom in (fraction of the starting distance)
  const MAX_ZOOM = 4;         // furthest the scroll wheel can zoom out
  const FOV = 30;             // normal vertical field of view in degrees

  const VIEWCUBE_HTML = `
    <div class="viewcube-wrap">
      <div class="viewcube-home" title="Home view">⌂</div>
      <div class="viewcube">
        <div class="cube-face" data-x="0" data-y="0" style="transform: translateZ(30px)">FRONT</div>
        <div class="cube-face" data-x="0" data-y="180" style="transform: rotateY(180deg) translateZ(30px)">BACK</div>
        <div class="cube-face" data-x="0" data-y="-90" style="transform: rotateY(90deg) translateZ(30px)">RIGHT</div>
        <div class="cube-face" data-x="0" data-y="90" style="transform: rotateY(-90deg) translateZ(30px)">LEFT</div>
        <div class="cube-face" data-x="-90" data-y="0" style="transform: rotateX(90deg) translateZ(30px)">TOP</div>
        <div class="cube-face" data-x="90" data-y="0" style="transform: rotateX(-90deg) translateZ(30px)">BOTTOM</div>
        <div class="axis axis-x"></div>
        <div class="axis axis-y"></div>
        <div class="axis axis-z"></div>
        <!-- data-pos is the label's spot just past each axis tip; JS keeps the letters facing the camera -->
        <div class="axis-label" data-pos="62px, 30px, 30px" style="color: #e5534b">X</div>
        <div class="axis-label" data-pos="-30px, 30px, -62px" style="color: #4cc35a">Y</div>
        <div class="axis-label" data-pos="-30px, -62px, 30px" style="color: #5468e8">Z</div>
      </div>
    </div>`;

  function createViewer(THREE, section, { load, staticOnPhones = false, wheelZoom = true }) {
    section.classList.add('viewer');
    // staticOnPhones: on phone-width screens the model just spins on its own; touches pass through
    // so swiping over it scrolls the page (the same 720px breakpoint the nav bar uses)
    if (staticOnPhones) {
      const phone = window.matchMedia('(max-width: 720px)');
      const update = () => section.classList.toggle('viewer-static', phone.matches);
      update();
      phone.addEventListener('change', update);
    }
    section.innerHTML = `<div class="viewer-scene"></div><div class="viewer-status">Loading…</div>${VIEWCUBE_HTML}`;
    const container = section.querySelector('.viewer-scene');
    const statusEl = section.querySelector('.viewer-status');
    const viewcube = section.querySelector('.viewcube');
    const axisLabels = section.querySelectorAll('.axis-label');

    // ---------- Three.js setup ----------
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // Capped at 1.5: on high-DPI screens 2x means drawing almost twice the pixels for little visible gain
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 10000);

    // Lights stay fixed relative to the camera, like Fusion's viewport lighting
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-300, 500, 600);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(400, 100, 300);
    scene.add(fill);

    // Everything that rotates (model + grid) lives in this group
    const world = new THREE.Group();
    scene.add(world);

    let modelRadius = 100;
    let fit = () => 500;
    let baseDist = 500;      // camera distance that fits the whole model
    let zoom = 1;            // current zoom, eased toward zoomTarget
    let zoomTarget = 1;
    let frameRect = null;    // set by setFrame: the part of the section the model is fitted into
    let pose = { blend: 0, x: 0, y: 0, fov: FOV }; // set by setPose
    let frozen = null;       // while a pose is blended in: the fixed Y angle to turn toward, the short way round
    let grid = null;
    let gridOpacity = 1;

    function makeGrid(size, minor, major) {
      // Real 1px lines like Fusion's grid (a texture goes blurry at shallow angles), fading out toward the edges.
      // Faint minor lines, darker major lines, and the red X / green Y axes through the origin.
      const half = size / 2;
      const group = new THREE.Group();
      const addLines = (positions, color, opacity, order) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const lines = new THREE.LineSegments(geometry, new THREE.ShaderMaterial({
          uniforms: {
            color: { value: new THREE.Color(color) },
            opacity: { value: opacity },
            fade: { value: new THREE.Vector2(half * 0.45, half) }, // fully visible out to 45%, gone at the edge
          },
          vertexShader: `
            varying vec2 vPos;
            void main() {
              vPos = position.xz;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: `
            uniform vec3 color;
            uniform float opacity;
            uniform vec2 fade;
            varying vec2 vPos;
            void main() {
              gl_FragColor = vec4(color, opacity * (1.0 - smoothstep(fade.x, fade.y, length(vPos))));
              #include <colorspace_fragment>
            }`,
          transparent: true,
          depthWrite: false,
        }));
        lines.renderOrder = order;
        group.add(lines);
      };

      const minorLines = [], majorLines = [];
      const count = Math.round(half / minor);
      const majorEvery = Math.round(major / minor);
      for (let i = -count; i <= count; i++) {
        if (i === 0) continue; // the coloured axes go here instead
        const v = i * minor;
        (i % majorEvery === 0 ? majorLines : minorLines).push(v, 0, -half, v, 0, half, -half, 0, v, half, 0, v);
      }
      addLines(minorLines, 0x000000, 0.1, 0);
      addLines(majorLines, 0x000000, 0.22, 1);
      addLines([-half, 0, 0, half, 0, 0], 0xe5534b, 0.85, 2); // X axis
      addLines([0, 0, -half, 0, 0, half], 0x4cc35a, 0.85, 2); // Y axis (Fusion's Y lies along three.js Z here)
      return group;
    }

    load({ setStatus: text => { statusEl.innerHTML = text; } }).then(result => {
      modelRadius = result.radius;
      fit = result.fit;
      world.add(result.model);

      grid = makeGrid(result.grid.size, result.grid.minor, result.grid.major);
      grid.position.y = result.floorY;
      world.add(grid);
      applyGridOpacity();

      statusEl.remove();
      resize();
    }).catch(err => {
      console.error(err);
      statusEl.textContent = `Could not load the model (${err?.message || err}).`;
    });

    function resize() {
      renderer.setSize(container.clientWidth, container.clientHeight);
      updateCamera();
    }

    function updateCamera() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.fov = pose.fov;
      if (frameRect && frameRect.width >= 1 && frameRect.height >= 1) {
        // Treat the frame as if it were the whole view, and draw the canvas as a window around it,
        // so the model is centred and fitted in the frame but can still be drawn anywhere on the canvas
        camera.aspect = frameRect.width / frameRect.height;
        camera.setViewOffset(frameRect.width, frameRect.height, -frameRect.x, -frameRect.y, w, h);
      } else {
        camera.aspect = w / h;
        camera.clearViewOffset();
      }
      baseDist = fit(THREE.MathUtils.degToRad(camera.fov), camera.aspect);
      // A narrower field of view moves the camera further back, so the near plane moves out with it
      // to keep the same depth precision
      camera.near = (modelRadius / 100) * (FOV / camera.fov);
      camera.far = baseDist * MAX_ZOOM * 10;
      camera.updateProjectionMatrix();
    }

    function applyGridOpacity() {
      if (!grid) return;
      grid.visible = gridOpacity > 0;
      for (const lines of grid.children) {
        const { opacity } = lines.material.uniforms;
        lines.userData.baseOpacity ??= opacity.value;
        opacity.value = lines.userData.baseOpacity * gridOpacity;
      }
    }
    new ResizeObserver(resize).observe(container);
    resize();

    // ---------- Interaction ----------
    let rotX = HOME_TILT, rotY = HOME_TURN; // degrees, same convention as the CSS ViewCube
    let velX = 0, velY = 0;                 // degrees per second, used for inertia after release
    let dragging = false;
    let lastX = 0, lastY = 0, lastMoveTime = 0;
    let lastInteraction = -Infinity;
    let snapTarget = null;                  // set when a ViewCube face or Home is clicked
    const pointers = new Map();             // fingers/mouse currently down: one rotates, two pinch-zoom
    let pinchDist = 0;

    function pinchDistance() {
      const [a, b] = pointers.values();
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    container.addEventListener('pointerdown', e => {
      // The page is steering the view, so dragging would only fight it
      if (frozen) return;
      container.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragging = true;
      snapTarget = null;
      container.classList.add('dragging');
      velX = velY = 0;
      lastInteraction = performance.now();
      if (pointers.size === 1) {
        lastX = e.clientX;
        lastY = e.clientY;
        lastMoveTime = performance.now();
      } else if (pointers.size === 2) {
        pinchDist = pinchDistance();
      }
    });

    container.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId) || frozen) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = performance.now();
      lastInteraction = now;

      // Two fingers: spreading them apart zooms in, pinching together zooms out
      if (pointers.size === 2) {
        const dist = pinchDistance();
        if (pinchDist > 0 && dist > 0) {
          zoomTarget = clamp(zoomTarget * (pinchDist / dist), MIN_ZOOM, MAX_ZOOM);
        }
        pinchDist = dist;
        return;
      }
      if (pointers.size !== 1) return;

      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      const dt = Math.max((now - lastMoveTime) / 1000, 0.001);
      rotY += dx * 0.4;
      rotX = clamp(rotX - dy * 0.4, -90, 90);
      // Smooth the velocity so a single jittery event doesn't fling it
      velY = velY * 0.6 + (dx * 0.4 / dt) * 0.4;
      velX = velX * 0.6 + (-dy * 0.4 / dt) * 0.4;
      lastX = e.clientX;
      lastY = e.clientY;
      lastMoveTime = now;
    });

    function endDrag(e) {
      if (!pointers.delete(e.pointerId)) return;
      const now = performance.now();
      lastInteraction = now;
      if (pointers.size === 2) {
        pinchDist = pinchDistance();
      } else if (pointers.size === 1) {
        // Lifted one finger of a pinch: carry on rotating from the remaining finger without a jump
        const [p] = pointers.values();
        lastX = p.x;
        lastY = p.y;
        lastMoveTime = now;
        velX = velY = 0;
      } else if (pointers.size === 0) {
        dragging = false;
        container.classList.remove('dragging');
        // If the pointer stopped before release, don't keep spinning
        if (now - lastMoveTime > 80) velX = velY = 0;
      }
    }
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);

    function snapTo(x, y) {
      // Pick the equivalent Y angle closest to the current one so it turns the short way
      const turns = Math.round((rotY - y) / 360);
      snapTarget = { x, y: y + turns * 360 };
      velX = velY = 0;
    }
    section.querySelectorAll('.cube-face').forEach(face => {
      face.addEventListener('click', () => snapTo(Number(face.dataset.x), Number(face.dataset.y)));
    });
    section.querySelector('.viewcube-home').addEventListener('click', () => {
      snapTo(HOME_TILT, HOME_TURN);
      zoomTarget = 1;
    });

    // Scroll wheel zooms in and out (trackpad pinch also arrives as wheel events)
    if (wheelZoom) {
      container.addEventListener('wheel', e => {
        e.preventDefault();
        const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // lines → pixels
        zoomTarget = clamp(zoomTarget * Math.exp(delta * 0.0015), MIN_ZOOM, MAX_ZOOM);
      }, { passive: false });
    }

    let prev = performance.now();
    let running = false;
    let onScreen = true;
    function start() {
      if (running) return;
      running = true;
      prev = performance.now();
      requestAnimationFrame(frame);
    }
    // Stop drawing while the viewer is scrolled out of sight, and pick up again when it comes back
    new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) start();
    }).observe(section);

    function frame(now) {
      if (!onScreen) {
        running = false;
        return;
      }
      const dt = Math.min((now - prev) / 1000, 0.05);
      prev = now;

      if (frozen) {
        // The page holds the view, so the free rotation waits where it is. Counting this as long idle means
        // the auto-spin eases straight back in once the page lets go.
        lastInteraction = now - IDLE_MS;
      } else if (snapTarget) {
        const ease = 1 - Math.pow(0.002, dt);
        rotX += (snapTarget.x - rotX) * ease;
        rotY += (snapTarget.y - rotY) * ease;
        lastInteraction = now;
        if (Math.abs(snapTarget.x - rotX) < 0.05 && Math.abs(snapTarget.y - rotY) < 0.05) {
          rotX = snapTarget.x;
          rotY = snapTarget.y;
          snapTarget = null;
        }
      } else if (!dragging) {
        // Inertia from the last flick, fading out
        rotY += velY * dt;
        rotX = clamp(rotX + velX * dt, -90, 90);
        const friction = Math.pow(0.04, dt);
        velY *= friction;
        velX *= friction;

        // Once idle, ease back into a gentle automatic spin at the home tilt
        if (now - lastInteraction > IDLE_MS) {
          const ease = 1 - Math.pow(0.3, dt);
          velY += (AUTO_SPEED - velY) * ease;
          rotX += (HOME_TILT - rotX) * ease;
          velX *= 1 - ease;
        }
      }

      zoom += (zoomTarget - zoom) * (1 - Math.pow(0.0001, dt));
      const [viewX, viewY] = applyView();

      viewcube.style.transform = `translateZ(-30px) rotateX(${viewX}deg) rotateY(${viewY}deg)`;
      // Undo the cube's rotation on the axis letters so they always face the viewer
      for (const label of axisLabels) {
        label.style.transform = `translate3d(${label.dataset.pos}) rotateY(${-viewY}deg) rotateX(${-viewX}deg) translate(-50%, -50%)`;
      }

      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    }

    // Places the camera and turns the model for the current state, blending toward the page's pose if it set one.
    // Returns the angles shown, in degrees.
    function applyView() {
      const t = frozen ? pose.blend : 0;
      const viewX = rotX + (pose.x - rotX) * t;
      const viewY = rotY + ((frozen ? frozen.y : rotY) - rotY) * t;
      camera.position.set(0, 0, baseDist * (zoom + (1 - zoom) * t));
      // CSS has Y pointing down and three.js has Y pointing up, so the X tilt flips sign
      world.rotation.set(THREE.MathUtils.degToRad(-viewX), THREE.MathUtils.degToRad(viewY), 0);
      return [viewX, viewY];
    }

    start();

    return {
      setFrame(rect) {
        frameRect = rect;
        updateCamera();
        applyView();
      },
      setPose({ blend = 0, x = 0, y = 0, fov = FOV }) {
        if (blend > 0 && !frozen) {
          // Stop any spin or flick where it is, and pick the target angle that turns the short way
          frozen = { y: y + Math.round((rotY - y) / 360) * 360 };
          velX = velY = 0;
          snapTarget = null;
        } else if (blend <= 0) {
          frozen = null;
        }
        const fovChanged = fov !== pose.fov;
        pose = { blend, x, y, fov };
        if (fovChanged) updateCamera();
        applyView();
      },
      setGridOpacity(a) {
        gridOpacity = a;
        applyGridOpacity();
      },
      project(point) {
        applyView();
        world.updateMatrixWorld(true);
        camera.updateMatrixWorld();
        const p = point.clone().applyMatrix4(world.matrixWorld).project(camera);
        return { x: (p.x + 1) / 2 * container.clientWidth, y: (1 - p.y) / 2 * container.clientHeight };
      },
    };
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  window.createViewer = createViewer;
})();
