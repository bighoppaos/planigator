/**
 * NPZ loader: reads a NumPy .npz archive (ZIP of .npy files) and returns
 * a map of { [key: string]: Float32Array } with shape metadata attached.
 *
 * Supports float32, float64, int32, int64 dtypes.
 * Both C-order and F-order arrays are returned as flat typed arrays.
 */

import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

const MAGIC = '\x93NUMPY';

/**
 * Parse a single .npy buffer.
 * @param {ArrayBuffer} buf
 * @returns {{ data: Float32Array, shape: number[], dtype: string }}
 */
function parseNpy(buf) {
  const bytes = new Uint8Array(buf);
  // Validate magic
  for (let i = 0; i < 6; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) {
      throw new Error('Not a valid .npy file (bad magic)');
    }
  }
  const majorVersion = bytes[6];
  const headerLen = majorVersion >= 2
    ? new DataView(buf, 8, 4).getUint32(0, true)
    : new DataView(buf, 8, 2).getUint16(0, true);
  const headerOffset = majorVersion >= 2 ? 12 : 10;
  const headerBytes = bytes.slice(headerOffset, headerOffset + headerLen);
  const header = new TextDecoder().decode(headerBytes).trim();

  // Parse header dict: "{'descr': '<f4', 'fortran_order': False, 'shape': (N, M), }"
  const descrMatch = header.match(/'descr'\s*:\s*'([^']+)'/);
  const shapeMatch = header.match(/'shape'\s*:\s*\(([^)]*)\)/);
  const fortranMatch = header.match(/'fortran_order'\s*:\s*(True|False)/);

  if (!descrMatch || !shapeMatch) {
    throw new Error(`Cannot parse .npy header: ${header}`);
  }

  const descr = descrMatch[1];
  const shapeStr = shapeMatch[1].trim();
  const shape = shapeStr === '' ? [1] : shapeStr.split(',').map(s => s.trim()).filter(Boolean).map(Number);
  const fortranOrder = fortranMatch ? fortranMatch[1] === 'True' : false;

  const dataOffset = headerOffset + headerLen;
  const dataBuffer = buf.slice(dataOffset);

  // Determine dtype
  // descr examples: '<f4', '<f8', '<i4', '<i8', '>f4', '|u1'
  const dtype = descr.replace(/[<>|=]/, '');
  let data;
  switch (dtype) {
    case 'f4':
      data = new Float32Array(dataBuffer);
      break;
    case 'f8': {
      const f64 = new Float64Array(dataBuffer);
      data = new Float32Array(f64.length);
      for (let i = 0; i < f64.length; i++) data[i] = f64[i];
      break;
    }
    case 'i4':
      data = new Int32Array(dataBuffer);
      break;
    case 'i8': {
      // BigInt64 — convert to regular Float32 (lossy but sufficient for embeddings)
      const i64 = new BigInt64Array(dataBuffer);
      data = new Float32Array(i64.length);
      for (let i = 0; i < i64.length; i++) data[i] = Number(i64[i]);
      break;
    }
    case 'u1':
      data = new Uint8Array(dataBuffer);
      break;
    default:
      throw new Error(`Unsupported .npy dtype: ${descr}`);
  }

  // If Fortran order, transpose to C order (row-major)
  if (fortranOrder && shape.length === 2) {
    const [rows, cols] = shape;
    const cOrder = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cOrder[r * cols + c] = data[c * rows + r];
      }
    }
    data = cOrder;
  }

  // Attach shape metadata
  const result = new Float32Array(data.buffer, data.byteOffset, data.length);
  result.shape = shape;
  return { data: result, shape, dtype };
}

/**
 * Load an .npz file (ZIP archive of .npy files).
 * @param {ArrayBuffer | Buffer} npzBuffer
 * @returns {Promise<{ [key: string]: { data: Float32Array, shape: number[] } }>}
 */
export async function loadNpz(npzBuffer) {
  const zip = await JSZip.loadAsync(npzBuffer);
  const result = {};

  const entries = Object.entries(zip.files).filter(([name]) => name.endsWith('.npy') && !zip.files[name].dir);

  await Promise.all(entries.map(async ([name, file]) => {
    const arrayBuffer = await file.async('arraybuffer');
    const key = name.replace(/\.npy$/, '');
    const parsed = parseNpy(arrayBuffer);
    result[key] = parsed;
  }));

  return result;
}
