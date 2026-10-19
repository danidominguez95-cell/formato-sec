"use strict";

const NOMBRE_CABECERA = "SIRA REGO";
const LIMITE_APARTADO = 750;
const MAX_BYTES_GROQ = 24 * 1024 * 1024; // límite gratuito de Groq: 25 MB por archivo
const SEGUNDOS_POR_TROZO = 600; // 10 min a 16 kHz mono WAV ≈ 19 MB
const MAX_HISTORIAL = 30;

const $ = (id) => document.getElementById(id);

// ---------- Almacenamiento local ----------

function leer(clave, porDefecto) {
  try {
    const v = localStorage.getItem(clave);
    return v === null ? porDefecto : JSON.parse(v);
  } catch {
    return porDefecto;
  }
}

function guardar(clave, valor) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento (modo privado): la app sigue funcionando sin recordar nada.
  }
}

const ajustes = () => ({
  groq: leer("clave-groq", ""),
  gemini: leer("clave-gemini", ""),
  modelo: leer("modelo-gemini", ""),
  vocabulario: leer("vocabulario", VOCABULARIO_INICIAL),
});

// ---------- Estado ----------

const estado = {
  modo: "audio",
  audio: null, // { blob, nombre }
  transcripcion: "",
  idActual: null,
  grabador: null,
  wakeLock: null,
};

// ---------- Navegación ----------

function irA(vista) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("activo", t.dataset.vista === vista));
  document.querySelectorAll(".vista").forEach((v) => v.classList.toggle("activa", v.id === "vista-" + vista));
  if (vista === "historial") pintarHistorial();
  window.scrollTo(0, 0);
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => irA(t.dataset.vista)));
document.querySelectorAll("[data-ir]").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    irA(a.dataset.ir);
  })
);

document.querySelectorAll(".modo").forEach((b) =>
  b.addEventListener("click", () => {
    estado.modo = b.dataset.modo;
    document.querySelectorAll(".modo").forEach((x) => x.classList.toggle("activo", x === b));
    $("modo-audio").classList.toggle("oculto", estado.modo !== "audio");
    $("modo-texto").classList.toggle("oculto", estado.modo !== "texto");
    actualizarBotonProcesar();
  })
);

function actualizarBotonProcesar() {
  const listo = estado.modo === "audio" ? !!estado.audio : $("texto-pegado").value.trim().length > 0;
  $("btn-procesar").disabled = !listo;
}
$("texto-pegado").addEventListener("input", actualizarBotonProcesar);

function comprobarClaves() {
  const a = ajustes();
  $("aviso-claves").classList.toggle("oculto", !!(a.groq && a.gemini));
}

// ---------- Audio: archivo, grabación y compartido ----------

function ponerAudio(blob, nombre) {
  estado.audio = { blob, nombre };
  $("audio-nombre").textContent = `${nombre} · ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
  $("audio-preview").src = URL.createObjectURL(blob);
  $("audio-listo").classList.remove("oculto");
  actualizarBotonProcesar();
}

$("archivo").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) ponerAudio(f, f.name);
  e.target.value = "";
});

function tipoGrabacion() {
  const candidatos = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return candidatos.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}

$("btn-grabar").addEventListener("click", async () => {
  ocultarError();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    mostrarError("No se ha podido usar el micrófono. Revisa los permisos del navegador.");
    return;
  }
  const mimeType = tipoGrabacion();
  const grabador = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
  const trozos = [];
  grabador.ondataavailable = (e) => e.data.size && trozos.push(e.data);
  grabador.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(grabador.reloj);
    soltarPantalla();
    const tipo = grabador.mimeType || mimeType || "audio/webm";
    const ext = tipo.includes("mp4") ? "m4a" : tipo.includes("ogg") ? "ogg" : "webm";
    ponerAudio(new Blob(trozos, { type: tipo }), `grabacion-${hoyISO()}.${ext}`);
    $("grabando").classList.add("oculto");
    $("btn-grabar").disabled = false;
  };
  grabador.start(1000);
  estado.grabador = grabador;
  const inicio = Date.now();
  grabador.reloj = setInterval(() => {
    const s = Math.floor((Date.now() - inicio) / 1000);
    $("tiempo").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
  $("tiempo").textContent = "0:00";
  $("grabando").classList.remove("oculto");
  $("btn-grabar").disabled = true;
  mantenerPantalla();
});

$("btn-parar").addEventListener("click", () => estado.grabador && estado.grabador.stop());

async function mantenerPantalla() {
  try {
    estado.wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // No disponible: se avisa en pantalla de que no se bloquee el móvil.
  }
}

function soltarPantalla() {
  try {
    estado.wakeLock && estado.wakeLock.release();
  } catch {}
  estado.wakeLock = null;
}

// Audio compartido desde otra app (Android), guardado por el service worker.
async function recogerCompartido() {
  if (!new URLSearchParams(location.search).has("compartido")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("compartido");
    const resp = await cache.match("audio-compartido");
    if (!resp) return;
    const nombre = decodeURIComponent(resp.headers.get("X-Nombre") || "audio-compartido");
    ponerAudio(await resp.blob(), nombre);
    await cache.delete("audio-compartido");
  } catch {
    mostrarError("No se ha podido recibir el audio compartido. Prueba con «Elegir archivo».");
  }
}

// ---------- Utilidades ----------

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fechaCabecera(iso) {
  const [a, m, d] = (iso || hoyISO()).split("-");
  return `${d}/${m}/${a}`;
}

function progreso(texto) {
  $("progreso").classList.toggle("oculto", !texto);
  if (texto) $("progreso-texto").textContent = texto;
}

function mostrarError(msg) {
  $("error").textContent = msg;
  $("error").classList.remove("oculto");
}

function ocultarError() {
  $("error").classList.add("oculto");
}

// ---------- Transcripción (Groq · Whisper) ----------

function nombreParaGroq(nombre, tipo) {
  // Groq reconoce el formato por la extensión; las notas de voz .opus son contenedores OGG.
  const ext = (nombre.split(".").pop() || "").toLowerCase();
  const validas = ["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"];
  if (validas.includes(ext)) return nombre;
  if (ext === "opus" || tipo.includes("ogg") || tipo.includes("opus")) return "audio.ogg";
  if (tipo.includes("mp4") || tipo.includes("aac") || ext === "aac") return "audio.m4a";
  if (tipo.includes("webm")) return "audio.webm";
  if (tipo.includes("wav")) return "audio.wav";
  return "audio.mp3";
}

async function transcribirTrozo(blob, nombre, clave, vocabulario) {
  for (let intento = 1; ; intento++) {
    const form = new FormData();
    form.append("file", blob, nombre);
    form.append("model", "whisper-large-v3");
    form.append("language", "es");
    form.append("response_format", "text");
    form.append("temperature", "0");
    if (vocabulario) form.append("prompt", vocabulario.slice(0, 800));

    let resp;
    try {
      resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${clave}` },
        body: form,
      });
    } catch {
      if (intento < 3) { await esperar(3000 * intento); continue; }
      throw new Error("No hay conexión con el servicio de transcripción.");
    }
    if (resp.ok) return (await resp.text()).trim();
    if (resp.status === 401) throw new Error("La clave de Groq no es válida. Revísala en Ajustes.");
    if ((resp.status === 429 || resp.status >= 500) && intento < 4) {
      const espera = Number(resp.headers.get("retry-after")) || 20 * intento;
      progreso(`Límite gratuito de transcripción alcanzado. Reintentando en ${espera} s…`);
      await esperar(espera * 1000);
      continue;
    }
    const detalle = await resp.text().catch(() => "");
    throw new Error(`Error al transcribir (${resp.status}). ${detalle.slice(0, 300)}`);
  }
}

async function decodificarAudio(blob) {
  const datos = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try {
    ctx = new Ctx({ sampleRate: 16000 });
  } catch {
    ctx = new Ctx();
  }
  try {
    return await new Promise((ok, mal) => {
      const p = ctx.decodeAudioData(datos, ok, mal);
      if (p && p.then) p.then(ok, mal);
    });
  } finally {
    ctx.close && ctx.close();
  }
}

function aMono16k(buffer) {
  const canales = buffer.numberOfChannels;
  const largo = buffer.length;
  const mono = new Float32Array(largo);
  for (let c = 0; c < canales; c++) {
    const datos = buffer.getChannelData(c);
    for (let i = 0; i < largo; i++) mono[i] += datos[i] / canales;
  }
  if (buffer.sampleRate === 16000) return mono;
  const ratio = buffer.sampleRate / 16000;
  const salida = new Float32Array(Math.floor(largo / ratio));
  for (let i = 0; i < salida.length; i++) {
    const inicio = Math.floor(i * ratio);
    const fin = Math.min(largo, Math.floor((i + 1) * ratio));
    let suma = 0;
    for (let j = inicio; j < fin; j++) suma += mono[j];
    salida[i] = suma / Math.max(1, fin - inicio);
  }
  return salida;
}

function codificarWav(muestras, frecuencia) {
  const buf = new ArrayBuffer(44 + muestras.length * 2);
  const v = new DataView(buf);
  const texto = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  texto(0, "RIFF");
  v.setUint32(4, 36 + muestras.length * 2, true);
  texto(8, "WAVE");
  texto(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, frecuencia, true);
  v.setUint32(28, frecuencia * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  texto(36, "data");
  v.setUint32(40, muestras.length * 2, true);
  for (let i = 0; i < muestras.length; i++) {
    const s = Math.max(-1, Math.min(1, muestras[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function transcribir({ blob, nombre }) {
  const { groq, vocabulario } = ajustes();
  if (blob.size <= MAX_BYTES_GROQ) {
    progreso("Transcribiendo el audio…");
    return transcribirTrozo(blob, nombreParaGroq(nombre, blob.type || ""), groq, vocabulario);
  }

  progreso("El audio es largo: preparándolo en partes…");
  let muestras;
  try {
    muestras = aMono16k(await decodificarAudio(blob));
  } catch {
    throw new Error("No se ha podido leer este audio. Prueba a convertirlo a MP3 o M4A, o a recortarlo.");
  }
  const porTrozo = SEGUNDOS_POR_TROZO * 16000;
  const total = Math.ceil(muestras.length / porTrozo);
  const textos = [];
  for (let i = 0; i < total; i++) {
    progreso(`Transcribiendo parte ${i + 1} de ${total}…`);
    const wav = codificarWav(muestras.subarray(i * porTrozo, (i + 1) * porTrozo), 16000);
    textos.push(await transcribirTrozo(wav, `parte-${i + 1}.wav`, groq, vocabulario));
  }
  return textos.join("\n");
}

// ---------- Formato SEC (Google Gemini) ----------

const API_GEMINI = "https://generativelanguage.googleapis.com/v1beta";

// Las claves nuevas de AI Studio empiezan por "AQ." y las antiguas por "AIza". Se prueba primero
// la cabecera de clave de API y, si Google la rechaza, como token Bearer; se recuerda la que funciona.
async function fetchGemini(url, opciones, clave) {
  const modos = leer("modo-clave-gemini", "") === "bearer" ? ["bearer", "api-key"] : ["api-key", "bearer"];
  let resp;
  for (const modo of modos) {
    const auth = modo === "bearer" ? { Authorization: `Bearer ${clave}` } : { "x-goog-api-key": clave };
    resp = await fetch(url, { ...opciones, headers: { ...(opciones.headers || {}), ...auth } });
    if (resp.status !== 401) {
      guardar("modo-clave-gemini", modo);
      return resp;
    }
  }
  return resp;
}

async function listarModelos(clave) {
  const resp = await fetchGemini(`${API_GEMINI}/models?pageSize=200`, {}, clave);
  if ([400, 401, 403].includes(resp.status)) throw new Error("La clave de Gemini no es válida. Revísala en Ajustes.");
  if (!resp.ok) throw new Error(`No se han podido consultar los modelos de Gemini (${resp.status}).`);
  const datos = await resp.json();
  return (datos.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"));
}

function elegirModelo(modelos) {
  const excluir = /(lite|image|tts|live|audio|embedding|vision|learnlm|gemma|robotics|computer|exp)/;
  const version = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
  const candidatos = modelos
    .map((m) => m.name)
    .filter((n) => /gemini-\d.*flash/.test(n) && !excluir.test(n))
    .sort((a, b) => {
      const estableA = a.includes("preview") ? 0 : 1;
      const estableB = b.includes("preview") ? 0 : 1;
      return estableB - estableA || version(b) - version(a);
    });
  return candidatos[0] || "models/gemini-flash-latest";
}

async function modeloGemini(clave, forzarAuto) {
  const elegido = ajustes().modelo;
  if (elegido && !forzarAuto) return elegido;
  const cache = leer("modelo-auto", null);
  if (cache && !forzarAuto && Date.now() - cache.fecha < 7 * 86400000) return cache.nombre;
  const nombre = elegirModelo(await listarModelos(clave));
  guardar("modelo-auto", { nombre, fecha: Date.now() });
  return nombre;
}

async function formatear(transcripcion, tipo) {
  const { gemini } = ajustes();
  let modelo = await modeloGemini(gemini, false);
  const peticion = {
    systemInstruction: { parts: [{ text: PROMPT_SEC }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Tipo de intervención: ${tipo}\n\nTRANSCRIPCIÓN AUTOMÁTICA:\n${transcripcion}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
      responseSchema: ESQUEMA_SEC,
    },
  };

  for (let intento = 1; ; intento++) {
    progreso(`Aplicando el Formato SEC (${modelo.replace("models/", "")})…`);
    let resp;
    try {
      resp = await fetchGemini(`${API_GEMINI}/${modelo}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(peticion),
      }, gemini);
    } catch {
      if (intento < 3) { await esperar(3000 * intento); continue; }
      throw new Error("No hay conexión con Gemini.");
    }

    if (resp.ok) {
      const datos = await resp.json();
      const cand = (datos.candidates || [])[0];
      const texto = ((cand && cand.content && cand.content.parts) || [])
        .filter((p) => !p.thought && p.text)
        .map((p) => p.text)
        .join("");
      if (!texto) throw new Error(`Gemini no ha devuelto texto (${(cand && cand.finishReason) || "sin respuesta"}). Prueba a volver a generar.`);
      try {
        const json = JSON.parse(texto.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        return json.apartados || json;
      } catch {
        if (intento < 3) continue;
        throw new Error("La respuesta de Gemini no tenía el formato esperado. Prueba a volver a generar.");
      }
    }

    if ([400, 401, 403].includes(resp.status)) {
      const detalle = await resp.text().catch(() => "");
      if (resp.status === 401 || /API key|API_KEY|PERMISSION/i.test(detalle)) throw new Error("La clave de Gemini no es válida. Revísala en Ajustes.");
      throw new Error(`Error de Gemini (${resp.status}). ${detalle.slice(0, 300)}`);
    }
    if (resp.status === 404 && intento < 3) {
      // El modelo guardado ya no existe: se busca otro automáticamente.
      modelo = await modeloGemini(gemini, true);
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && intento < 4) {
      const espera = 20 * intento;
      progreso(`Gemini está ocupado o se ha alcanzado el límite gratuito. Reintentando en ${espera} s…`);
      await esperar(espera * 1000);
      continue;
    }
    const detalle = await resp.text().catch(() => "");
    throw new Error(`Error de Gemini (${resp.status}). ${detalle.slice(0, 300)}`);
  }
}

// ---------- Montaje del texto para WhatsApp ----------

function limpiarTitulo(t) {
  return String(t || "")
    .replace(/[*✅"“”«»„‘’'`#_]/g, "")
    .replace(/^título:\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim()
    .toLocaleUpperCase("es-ES");
}

function limpiarTexto(t) {
  return String(t || "")
    .replace(/^texto:\s*/i, "")
    .replace(/[*_#`]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

function montarTexto(apartados, fechaISO, tipo) {
  const cabecera = `*${fechaCabecera(fechaISO)} - ${NOMBRE_CABECERA} - ${tipo}*`;
  const bloques = apartados
    .map((a) => ({ titulo: limpiarTitulo(a.titulo), texto: limpiarTexto(a.texto) }))
    .filter((a) => a.titulo && a.texto)
    .map((a) => `*✅ ${a.titulo}*\n\n${a.texto}`);
  return [cabecera, ...bloques].join("\n\n");
}

function revisarLongitudes() {
  const texto = $("salida").value;
  const partes = texto.split(/^\*✅ (.+?)\*\s*$/m);
  const avisos = [];
  for (let i = 1; i < partes.length; i += 2) {
    const largo = partes[i + 1].trim().length;
    if (largo > LIMITE_APARTADO) avisos.push(`«${partes[i]}»: ${largo} caracteres (máx. ${LIMITE_APARTADO})`);
  }
  $("avisos-longitud").innerHTML = "";
  avisos.forEach((a) => {
    const li = document.createElement("li");
    li.textContent = a;
    $("avisos-longitud").appendChild(li);
  });
}
$("salida").addEventListener("input", () => {
  revisarLongitudes();
  actualizarHistorial();
});

// ---------- Proceso principal ----------

function datosIntervencion() {
  const tipo = ($("tipo").value || "").trim().replace(/\s+/g, " ").toLocaleUpperCase("es-ES") || "DECLARACIONES";
  return { fecha: $("fecha").value || hoyISO(), tipo };
}

async function procesar(soloFormato) {
  ocultarError();
  const a = ajustes();
  if (!a.gemini || (!soloFormato && estado.modo === "audio" && !a.groq)) {
    mostrarError("Faltan claves. Añádelas en Ajustes.");
    return;
  }
  const { fecha, tipo } = datosIntervencion();
  $("btn-procesar").disabled = true;
  $("btn-regenerar").disabled = true;
  try {
    if (!soloFormato) {
      estado.transcripcion = estado.modo === "audio" ? await transcribir(estado.audio) : $("texto-pegado").value.trim();
      estado.idActual = null;
    }
    if (!estado.transcripcion) throw new Error("La transcripción ha salido vacía. ¿Tiene voz el audio?");
    const apartados = await formatear(estado.transcripcion, tipo);
    $("salida").value = montarTexto(apartados, fecha, tipo);
    $("transcripcion-original").textContent = estado.transcripcion;
    $("resultado").classList.remove("oculto");
    revisarLongitudes();
    guardarEnHistorial(fecha, tipo);
    $("resultado").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    mostrarError(e.message || String(e));
  } finally {
    progreso("");
    actualizarBotonProcesar();
    $("btn-regenerar").disabled = false;
  }
}

$("btn-procesar").addEventListener("click", () => procesar(false));
$("btn-regenerar").addEventListener("click", () => estado.transcripcion && procesar(true));
$("btn-ver-transcripcion").addEventListener("click", () => $("transcripcion-original").classList.toggle("oculto"));

$("btn-copiar").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("salida").value);
  } catch {
    $("salida").select();
    document.execCommand("copy");
  }
  $("btn-copiar").textContent = "¡Copiado!";
  setTimeout(() => ($("btn-copiar").textContent = "Copiar"), 1500);
});

$("btn-whatsapp").addEventListener("click", async () => {
  const texto = $("salida").value;
  if (navigator.share) {
    try {
      await navigator.share({ text: texto });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, "_blank");
});

// ---------- Historial ----------

function guardarEnHistorial(fecha, tipo) {
  const lista = leer("historial", []);
  const id = estado.idActual || Date.now();
  estado.idActual = id;
  const entrada = { id, fecha, tipo, texto: $("salida").value, transcripcion: estado.transcripcion };
  const resto = lista.filter((x) => x.id !== id);
  guardar("historial", [entrada, ...resto].slice(0, MAX_HISTORIAL));
}

function actualizarHistorial() {
  if (!estado.idActual) return;
  const lista = leer("historial", []);
  const e = lista.find((x) => x.id === estado.idActual);
  if (e) {
    e.texto = $("salida").value;
    guardar("historial", lista);
  }
}

function pintarHistorial() {
  const ul = $("lista-historial");
  ul.innerHTML = "";
  const lista = leer("historial", []);
  if (!lista.length) {
    ul.innerHTML = "<li>Todavía no hay transcripciones.</li>";
    return;
  }
  lista.forEach((e) => {
    const li = document.createElement("li");
    const titulo = document.createElement("strong");
    titulo.textContent = `${fechaCabecera(e.fecha)} - ${e.tipo}`;
    const sub = document.createElement("small");
    sub.textContent = (e.texto.split("\n").find((l) => l.startsWith("*✅")) || "").replace(/\*/g, "");
    li.append(titulo, sub);
    li.addEventListener("click", () => {
      estado.idActual = e.id;
      estado.transcripcion = e.transcripcion;
      $("fecha").value = e.fecha;
      $("tipo").value = e.tipo;
      $("salida").value = e.texto;
      $("transcripcion-original").textContent = e.transcripcion;
      $("resultado").classList.remove("oculto");
      revisarLongitudes();
      irA("nueva");
      $("resultado").scrollIntoView();
    });
    ul.appendChild(li);
  });
}

// ---------- Ajustes ----------

function cargarAjustes() {
  const a = ajustes();
  $("clave-groq").value = a.groq;
  $("clave-gemini").value = a.gemini;
  $("vocabulario").value = a.vocabulario;
  if (a.modelo) {
    const op = document.createElement("option");
    op.value = op.textContent = a.modelo;
    $("modelo-gemini").appendChild(op);
    $("modelo-gemini").value = a.modelo;
  }
}

$("btn-guardar-ajustes").addEventListener("click", () => {
  guardar("clave-groq", $("clave-groq").value.trim());
  guardar("clave-gemini", $("clave-gemini").value.trim());
  guardar("modelo-gemini", $("modelo-gemini").value);
  $("estado-ajustes").textContent = "Guardado.";
  comprobarClaves();
});

$("btn-guardar-vocabulario").addEventListener("click", () => {
  guardar("vocabulario", $("vocabulario").value.trim());
  $("btn-guardar-vocabulario").textContent = "Guardado";
  setTimeout(() => ($("btn-guardar-vocabulario").textContent = "Guardar vocabulario"), 1500);
});

$("btn-probar").addEventListener("click", async () => {
  const groq = $("clave-groq").value.trim();
  const gemini = $("clave-gemini").value.trim();
  const msgs = [];
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${groq}` } });
    msgs.push(r.ok ? "Groq: correcta ✔" : `Groq: no válida (${r.status}) ✘`);
  } catch {
    msgs.push("Groq: sin conexión ✘");
  }
  try {
    const modelos = await listarModelos(gemini);
    const sel = $("modelo-gemini");
    const actual = sel.value;
    sel.innerHTML = '<option value="">Automático</option>';
    modelos
      .map((m) => m.name)
      .filter((n) => n.includes("gemini"))
      .forEach((n) => {
        const op = document.createElement("option");
        op.value = n;
        op.textContent = n.replace("models/", "");
        sel.appendChild(op);
      });
    sel.value = actual;
    msgs.push(`Gemini: correcta ✔ (automático: ${elegirModelo(modelos).replace("models/", "")})`);
  } catch (e) {
    msgs.push(`Gemini: ${e.message} ✘`);
  }
  $("estado-ajustes").textContent = msgs.join(" · ");
});

// ---------- Inicio ----------

$("fecha").value = hoyISO();
cargarAjustes();
comprobarClaves();
recogerCompartido();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
