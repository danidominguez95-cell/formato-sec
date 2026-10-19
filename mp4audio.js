"use strict";

// Extrae la pista de audio (AAC) de un vídeo MP4/MOV sin descodificarlo: lee solo la estructura del
// archivo y los fragmentos de audio, y los reempaqueta en uno o varios .m4a pequeños. Así un vídeo de
// cientos de MB se convierte en pocos MB sin cargarlo entero en la memoria del móvil.

async function leerBytes(blob, inicio, fin) {
  return new Uint8Array(await blob.slice(inicio, fin).arrayBuffer());
}

const tipoCaja = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// Cajas de nivel superior del archivo, leyendo solo sus cabeceras.
async function cajasSuperiores(blob) {
  const cajas = [];
  let pos = 0;
  while (pos + 8 <= blob.size) {
    const h = await leerBytes(blob, pos, Math.min(blob.size, pos + 16));
    const v = new DataView(h.buffer);
    let tam = v.getUint32(0);
    let cab = 8;
    if (tam === 1) {
      tam = v.getUint32(8) * 4294967296 + v.getUint32(12);
      cab = 16;
    } else if (tam === 0) {
      tam = blob.size - pos;
    }
    if (tam < cab) throw new Error("Estructura MP4 no válida");
    cajas.push({ tipo: tipoCaja(h, 4), inicio: pos, fin: pos + tam });
    pos += tam;
  }
  return cajas;
}

// Cajas hijas dentro de un buffer en memoria.
function cajasHijas(b, inicio, fin) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const res = [];
  let pos = inicio;
  while (pos + 8 <= fin) {
    let tam = v.getUint32(pos);
    let cab = 8;
    if (tam === 1) {
      tam = v.getUint32(pos + 8) * 4294967296 + v.getUint32(pos + 12);
      cab = 16;
    } else if (tam === 0) {
      tam = fin - pos;
    }
    if (tam < cab || pos + tam > fin) break;
    res.push({ tipo: tipoCaja(b, pos + 4), inicio: pos, fin: pos + tam, datos: pos + cab });
    pos += tam;
  }
  return res;
}

const cajaHija = (b, caja, tipo) => caja && cajasHijas(b, caja.datos, caja.fin).find((c) => c.tipo === tipo);

function pistaDeAudio(m, moov) {
  for (const trak of cajasHijas(m, moov.datos, moov.fin).filter((c) => c.tipo === "trak")) {
    const mdia = cajaHija(m, trak, "mdia");
    const hdlr = cajaHija(m, mdia, "hdlr");
    if (hdlr && tipoCaja(m, hdlr.datos + 8) === "soun") return mdia;
  }
  return null;
}

function tablasDeMuestras(m, mdia) {
  const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const mdhd = cajaHija(m, mdia, "mdhd");
  const escala = v.getUint32(mdhd.datos + (m[mdhd.datos] === 1 ? 20 : 12));
  const stbl = cajaHija(m, cajaHija(m, mdia, "minf"), "stbl");
  const caja = (t) => cajaHija(m, stbl, t);
  const stsd = caja("stsd");
  const stts = caja("stts");
  const stsc = caja("stsc");
  const stsz = caja("stsz");
  const stco = caja("stco") || caja("co64");
  if (!stsd || !stts || !stsc || !stsz || !stco) throw new Error("Faltan tablas de audio");
  if (tipoCaja(m, stsd.datos + 12) !== "mp4a") throw new Error("El audio no es AAC");

  const tamFijo = v.getUint32(stsz.datos + 4);
  const n = v.getUint32(stsz.datos + 8);
  if (tamFijo === 1) throw new Error("Formato de audio antiguo no compatible");
  if (n === 0) throw new Error("MP4 fragmentado: sin tablas de muestras");
  const tamanos = new Uint32Array(n);
  for (let i = 0; i < n; i++) tamanos[i] = tamFijo || v.getUint32(stsz.datos + 12 + i * 4);

  const duraciones = new Uint32Array(n);
  let s = 0;
  for (let e = 0, ne = v.getUint32(stts.datos + 4); e < ne; e++) {
    const cuenta = v.getUint32(stts.datos + 8 + e * 8);
    const delta = v.getUint32(stts.datos + 12 + e * 8);
    for (let k = 0; k < cuenta && s < n; k++) duraciones[s++] = delta;
  }

  const es64 = stco.tipo === "co64";
  const nTrozos = v.getUint32(stco.datos + 4);
  const desplTrozo = (c) =>
    es64
      ? v.getUint32(stco.datos + 8 + c * 8) * 4294967296 + v.getUint32(stco.datos + 12 + c * 8)
      : v.getUint32(stco.datos + 8 + c * 4);
  const nStsc = v.getUint32(stsc.datos + 4);
  const primero = (e) => v.getUint32(stsc.datos + 8 + e * 12);
  const porTrozo = (e) => v.getUint32(stsc.datos + 12 + e * 12);

  const posiciones = new Float64Array(n);
  s = 0;
  for (let c = 0, e = 0; c < nTrozos && s < n; c++) {
    while (e + 1 < nStsc && c + 1 >= primero(e + 1)) e++;
    let pos = desplTrozo(c);
    for (let k = 0; k < porTrozo(e) && s < n; k++, s++) {
      posiciones[s] = pos;
      pos += tamanos[s];
    }
  }
  if (s < n) throw new Error("Tablas de audio incompletas");

  return { escala, stsd: m.slice(stsd.inicio, stsd.fin), tamanos, duraciones, posiciones, n };
}

// ---------- Escritura del .m4a ----------

function u32Lista(valores) {
  const b = new Uint8Array(valores.length * 4);
  const v = new DataView(b.buffer);
  for (let i = 0; i < valores.length; i++) v.setUint32(i * 4, valores[i]);
  return b;
}

const u32 = (...valores) => u32Lista(valores);

function u16(...valores) {
  const b = new Uint8Array(valores.length * 2);
  const v = new DataView(b.buffer);
  valores.forEach((x, i) => v.setUint16(i * 2, x));
  return b;
}

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function caja(tipo, ...partes) {
  const total = 8 + partes.reduce((a, p) => a + p.length, 0);
  const b = new Uint8Array(total);
  new DataView(b.buffer).setUint32(0, total);
  b.set(ascii(tipo), 4);
  let pos = 8;
  for (const p of partes) {
    b.set(p, pos);
    pos += p.length;
  }
  return b;
}

const MATRIZ = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

function escribirM4a(ftyp, t, desde, hasta, datos) {
  const n = hasta - desde;
  let duracion = 0;
  const stts = [];
  for (let i = desde; i < hasta; i++) {
    duracion += t.duraciones[i];
    const ultimo = stts[stts.length - 1];
    if (ultimo && ultimo[1] === t.duraciones[i]) ultimo[0]++;
    else stts.push([1, t.duraciones[i]]);
  }
  const tamanos = u32Lista(t.tamanos.subarray(desde, hasta));

  const construirMoov = (desplMdat) =>
    caja("moov",
      caja("mvhd", u32(0, 0, 0, t.escala, duracion, 0x00010000), u16(0x0100, 0), u32(0, 0), MATRIZ, u32(0, 0, 0, 0, 0, 0, 2)),
      caja("trak",
        caja("tkhd", u32(0x00000007, 0, 0, 1, 0, duracion, 0, 0), u16(0, 0, 0x0100, 0), MATRIZ, u32(0, 0)),
        caja("mdia",
          caja("mdhd", u32(0, 0, 0, t.escala, duracion), u16(0x55c4, 0)),
          caja("hdlr", u32(0, 0), ascii("soun"), u32(0, 0, 0), ascii("SoundHandler\0")),
          caja("minf",
            caja("smhd", u32(0), u16(0, 0)),
            caja("dinf", caja("dref", u32(0, 1), caja("url ", u32(1)))),
            caja("stbl",
              t.stsd,
              caja("stts", u32(0, stts.length), u32Lista(stts.flat())),
              caja("stsc", u32(0, 1, 1, n, 1)),
              caja("stsz", u32(0, 0, n), tamanos),
              caja("stco", u32(0, 1, desplMdat))
            )
          )
        )
      )
    );

  // El tamaño de moov no depende del desplazamiento, así que se calcula una vez y se reescribe.
  const largoMoov = construirMoov(0).length;
  const moov = construirMoov(ftyp.length + largoMoov + 8);
  const cabMdat = new Uint8Array(8);
  new DataView(cabMdat.buffer).setUint32(0, 8 + datos.length);
  cabMdat.set(ascii("mdat"), 4);
  return new Blob([ftyp, moov, cabMdat, datos], { type: "audio/mp4" });
}

// Configuración AAC (AudioSpecificConfig) dentro de la caja esds de la descripción de audio.
function configAac(stsd) {
  let p = -1;
  for (let i = 0; i + 4 <= stsd.length; i++) {
    if (tipoCaja(stsd, i) === "esds") {
      p = i + 8; // tipo + versión/flags
      break;
    }
  }
  if (p < 0) throw new Error("Sin configuración AAC");
  const longitud = () => {
    let len = 0;
    for (let k = 0; k < 4; k++) {
      const byte = stsd[p++];
      len = (len << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return len;
  };
  if (stsd[p++] !== 0x03) throw new Error("esds no válido");
  longitud();
  p += 2;
  const flags = stsd[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + stsd[p];
  if (flags & 0x20) p += 2;
  if (stsd[p++] !== 0x04) throw new Error("esds no válido");
  longitud();
  p += 13;
  if (stsd[p++] !== 0x05) throw new Error("esds no válido");
  longitud();
  const aot = stsd[p] >> 3;
  const frecuencia = ((stsd[p] & 7) << 1) | (stsd[p + 1] >> 7);
  const canales = (stsd[p + 1] >> 3) & 0xf;
  if (aot < 1 || aot > 4 || frecuencia > 12 || canales < 1 || canales > 7) throw new Error("AAC no compatible con ADTS");
  return { aot, frecuencia, canales };
}

// Flujo AAC con cabecera ADTS por trama (.aac), formato que Gemini acepta directamente.
function escribirAdts(cfg, t, desde, hasta, datos) {
  const salida = new Uint8Array(datos.length + 7 * (hasta - desde));
  let o = 0;
  let d = 0;
  for (let i = desde; i < hasta; i++) {
    const len = t.tamanos[i];
    const trama = len + 7;
    salida[o] = 0xff;
    salida[o + 1] = 0xf1;
    salida[o + 2] = ((cfg.aot - 1) << 6) | (cfg.frecuencia << 2) | (cfg.canales >> 2);
    salida[o + 3] = ((cfg.canales & 3) << 6) | (trama >> 11);
    salida[o + 4] = (trama >> 3) & 0xff;
    salida[o + 5] = ((trama & 7) << 5) | 0x1f;
    salida[o + 6] = 0xfc;
    salida.set(datos.subarray(d, d + len), o + 7);
    o += trama;
    d += len;
  }
  return new Blob([salida], { type: "audio/aac" });
}

// Devuelve una lista de audios (Blob) de como máximo `maxBytes` cada uno, en .m4a o en .aac (ADTS).
async function extraerAudioMp4(blob, maxBytes, formato = "m4a") {
  const cajas = await cajasSuperiores(blob);
  const cMoov = cajas.find((c) => c.tipo === "moov");
  if (!cMoov) throw new Error("No es un MP4/MOV");
  const m = await leerBytes(blob, cMoov.inicio, cMoov.fin);
  const mdia = pistaDeAudio(m, cajasHijas(m, 0, m.length)[0]);
  if (!mdia) throw new Error("El archivo no tiene audio");
  const t = tablasDeMuestras(m, mdia);
  const cfg = formato === "adts" ? configAac(t.stsd) : null;

  const cFtyp = cajas.find((c) => c.tipo === "ftyp");
  const ftyp = cFtyp
    ? await leerBytes(blob, cFtyp.inicio, cFtyp.fin)
    : caja("ftyp", ascii("qt  "), u32(0), ascii("qt  "));

  const partes = [];
  let desde = 0;
  while (desde < t.n) {
    let hasta = desde;
    let bytes = 0;
    while (hasta < t.n && (hasta === desde || bytes + t.tamanos[hasta] <= maxBytes)) bytes += t.tamanos[hasta++];

    // Las muestras consecutivas en el archivo se leen de una vez.
    const datos = new Uint8Array(bytes);
    let escrito = 0;
    let i = desde;
    while (i < hasta) {
      let j = i + 1;
      while (j < hasta && t.posiciones[j] === t.posiciones[j - 1] + t.tamanos[j - 1]) j++;
      const fin = t.posiciones[j - 1] + t.tamanos[j - 1];
      datos.set(await leerBytes(blob, t.posiciones[i], fin), escrito);
      escrito += fin - t.posiciones[i];
      i = j;
    }
    partes.push(cfg ? escribirAdts(cfg, t, desde, hasta, datos) : escribirM4a(ftyp, t, desde, hasta, datos));
    desde = hasta;
  }
  return partes;
}
