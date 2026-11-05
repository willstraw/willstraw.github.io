// Compact model format for the 3D viewer.
//
// A Fusion OBJ export is plain text (64 MB for the suspension): slow to download, slow to read, and the
// outline edges then take seconds more to work out in the browser. encodeModel() does all of that once,
// ahead of time (tools/convert-model.html runs it), and saves the exact same triangles, normals, colours
// and outline edges in a small gzip-compressed .bin file. Parts that share a colour are merged, so the
// whole model draws in a handful of draw calls instead of hundreds.
// Pages load it with downloadModel() then readModel().
//
// File layout once un-gzipped (little-endian):
//   "MODL", header length (uint32), header JSON:
//     { version, positions, edges, meshes: [{ color: [r, g, b], vertices, triangles }] }
//   then blocks of 32-bit numbers, each stored by pack():
//     every distinct vertex position (x, y, z float bits)
//     per mesh: which position each vertex sits at, its normal (float bits), the triangle corners
//     the outline segments, as pairs of position numbers

import * as THREE from 'three';

const MAGIC = 'MODL';
const VERSION = 1;
const DEFAULT_COLOR = new THREE.Color(0xc9cdd3);   // parts with no colour in the export

// ---------- Packing ----------

// Stores 32-bit numbers so that gzip shrinks them well: each one becomes its difference from the number
// `stride` places before it (stride 0: kept as it is), zigzagged so small negative numbers stay small,
// and the bytes are regrouped so all the lowest bytes come first, then all the next ones, and so on.
function pack(values, stride) {
  const n = values.length;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const d = stride && i >= stride ? (values[i] - values[i - stride]) | 0 : values[i];
    const z = (d << 1) ^ (d >> 31);
    out[i] = z;
    out[n + i] = z >>> 8;
    out[2 * n + i] = z >>> 16;
    out[3 * n + i] = z >>> 24;
  }
  return out;
}

function unpack(bytes, offset, n, stride) {
  const out = new Int32Array(n);
  const b1 = offset + n, b2 = offset + 2 * n, b3 = offset + 3 * n;
  for (let i = 0; i < n; i++) {
    const z = bytes[offset + i] | (bytes[b1 + i] << 8) | (bytes[b2 + i] << 16) | (bytes[b3 + i] << 24);
    const d = (z >>> 1) ^ -(z & 1);
    out[i] = stride && i >= stride ? (out[i - stride] + d) | 0 : d;
  }
  return out;
}

// The raw bits of a float array, as integers
const floatBits = array => new Int32Array(array.buffer, array.byteOffset, array.length);

async function gzip(blob) {
  return new Uint8Array(await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Older browsers: three.js ships a small gzip library
  const { gunzipSync } = await import('three/addons/libs/fflate.module.js');
  return gunzipSync(bytes);
}

// ---------- Writing ----------

// object: what OBJLoader returns (with its MTL materials set). Returns the .bin file's bytes.
export async function encodeModel(object, { edgeAngle = 35 } = {}) {
  const batches = new Map();   // one per colour: its vertices (position + normal) and triangle corners
  const edgeEnds = [];         // outline segment ends, as position keys, in pairs

  const meshes = [];
  object.traverse(child => { if (child.isMesh) meshes.push(child); });

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const pos = floatBits(geometry.getAttribute('position').array);
    const normal = geometry.getAttribute('normal');
    if (!normal) throw new Error(`"${mesh.name}" has no normals`);
    const nor = floatBits(normal.array);
    const index = geometry.getIndex();
    const count = index ? index.count : geometry.getAttribute('position').count;

    // The stretches of triangles three.js would draw, each with its material
    const ranges = Array.isArray(mesh.material)
      ? geometry.groups.map(g => ({ start: g.start, count: g.count, material: mesh.material[g.materialIndex] }))
      : [{ start: 0, count, material: mesh.material }];

    for (const range of ranges) {
      if (!range.material || !range.material.visible) continue;
      const color = (range.material.color || DEFAULT_COLOR).toArray();
      const colorKey = color.join();
      let batch = batches.get(colorKey);
      if (!batch) {
        batch = { color, vertexIds: new Map(), posKeys: [], normals: [], corners: [] };
        batches.set(colorKey, batch);
      }
      const end = range.start + Math.floor((Math.min(range.start + range.count, count) - range.start) / 3) * 3;
      for (let i = range.start; i < end; i++) {
        const v = (index ? index.getX(i) : i) * 3;
        const posKey = pos[v] + ',' + pos[v + 1] + ',' + pos[v + 2];
        const vertexKey = posKey + ',' + nor[v] + ',' + nor[v + 1] + ',' + nor[v + 2];
        let id = batch.vertexIds.get(vertexKey);
        if (id === undefined) {
          id = batch.posKeys.length;
          batch.vertexIds.set(vertexKey, id);
          batch.posKeys.push(posKey);
          batch.normals.push(nor[v], nor[v + 1], nor[v + 2]);
        }
        batch.corners.push(id);
      }
    }

    // Outline edges, worked out exactly as the viewer used to do while loading
    const edges = floatBits(new THREE.EdgesGeometry(geometry, edgeAngle).getAttribute('position').array);
    for (let i = 0; i < edges.length; i += 3) edgeEnds.push(edges[i] + ',' + edges[i + 1] + ',' + edges[i + 2]);
  }

  // Number every distinct position in the order the merged meshes use them, so neighbours stay close
  const posIds = new Map();
  const positions = [];
  const posId = key => {
    let id = posIds.get(key);
    if (id === undefined) {
      id = posIds.size;
      posIds.set(key, id);
      positions.push(...key.split(',').map(Number));
    }
    return id;
  };

  const header = { version: VERSION, positions: 0, edges: 0, meshes: [] };
  const meshBlocks = [];
  for (const batch of batches.values()) {
    // Vertices are numbered in order of first use, so each triangle corner is stored as how far back it
    // is from the next new vertex (0 = a new one), which is nearly always a small number
    const corners = new Int32Array(batch.corners.length);
    let fresh = 0;
    batch.corners.forEach((v, i) => {
      corners[i] = fresh - v;
      if (v === fresh) fresh++;
    });
    meshBlocks.push(
      pack(Int32Array.from(batch.posKeys, posId), 1),
      pack(Int32Array.from(batch.normals), 3),
      pack(corners, 0),
    );
    header.meshes.push({ color: batch.color, vertices: batch.posKeys.length, triangles: corners.length / 3 });
  }

  // Outline segments as pairs of position numbers. The order they are drawn in makes no difference, so
  // they are sorted (and exact repeats dropped) to keep the numbers small: each pair is stored as the
  // step from the previous segment's start, then from its own start to its end.
  const segments = [];
  for (let i = 0; i < edgeEnds.length; i += 2) segments.push([posId(edgeEnds[i]), posId(edgeEnds[i + 1])]);
  segments.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const steps = [];
  let prev = null;
  for (const s of segments) {
    if (prev && s[0] === prev[0] && s[1] === prev[1]) continue;
    steps.push(s[0] - (prev ? prev[0] : 0), s[1] - s[0]);
    prev = s;
  }

  header.positions = positions.length / 3;
  header.edges = steps.length / 2;
  const json = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(8);
  prefix.set(Array.from(MAGIC, c => c.charCodeAt(0)));
  new DataView(prefix.buffer).setUint32(4, json.length, true);

  return gzip(new Blob([prefix, json, pack(Int32Array.from(positions), 3), ...meshBlocks, pack(Int32Array.from(steps), 0)]));
}

// ---------- Reading ----------

// Fetches a .bin model, reporting progress (0 to 1) as it downloads
export async function downloadModel(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded with ${response.status} ${response.statusText}`);
  const total = Number(response.headers.get('Content-Length'));
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total && onProgress) onProgress(Math.min(loaded / total, 1));
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

// Turns a downloaded .bin into geometry: one { color, geometry } per colour, plus the outline edges
export async function readModel(file) {
  // Normally still gzipped; skip that step if the server already unzipped it on the way
  const bytes = file[0] === 0x1f && file[1] === 0x8b ? await gunzip(file) : file;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error('not a model file made by tools/convert-model.html');
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
  if (header.version !== VERSION) throw new Error(`model file version ${header.version} is not supported`);

  let offset = 8 + headerLength;
  const next = (count, stride) => {
    const values = unpack(bytes, offset, count, stride);
    offset += count * 4;
    return values;
  };

  const positions = new Float32Array(next(header.positions * 3, 3).buffer);

  const meshes = header.meshes.map(({ color, vertices, triangles }) => {
    const posIds = next(vertices, 1);
    const normals = new Float32Array(next(vertices * 3, 3).buffer);
    const corners = next(triangles * 3, 0);

    const vertexPositions = new Float32Array(vertices * 3);
    for (let i = 0; i < vertices; i++) {
      const p = posIds[i] * 3;
      vertexPositions[i * 3] = positions[p];
      vertexPositions[i * 3 + 1] = positions[p + 1];
      vertexPositions[i * 3 + 2] = positions[p + 2];
    }

    const index = new (vertices > 65535 ? Uint32Array : Uint16Array)(corners.length);
    let fresh = 0;
    for (let i = 0; i < corners.length; i++) {
      const v = fresh - corners[i];
      index[i] = v;
      if (v === fresh) fresh++;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertexPositions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    return { color, geometry };
  });

  const steps = next(header.edges * 2, 0);
  const edgeIndex = new (header.positions > 65535 ? Uint32Array : Uint16Array)(steps.length);
  let start = 0;
  for (let i = 0; i < steps.length; i += 2) {
    start += steps[i];
    edgeIndex[i] = start;
    edgeIndex[i + 1] = start + steps[i + 1];
  }
  const edges = new THREE.BufferGeometry();
  edges.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  edges.setIndex(new THREE.BufferAttribute(edgeIndex, 1));

  return { meshes, edges };
}
