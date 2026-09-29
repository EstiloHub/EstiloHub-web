const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const {
  getFirestore,
  Timestamp,
  FieldValue
} = require("firebase-admin/firestore");

function getFirebaseAdmin() {
  if (getApps().length) return getApps()[0];

  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY
        .replace(/^"|"$/g, "")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .trim()
    : undefined;

  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    })
  });
}

const app = getFirebaseAdmin();
const auth = getAuth(app);
const db = getFirestore(app);

const MAX_ACTIVE_GAP_MS = 23000;
const ACTIVITY_WINDOW_MS = 30000;
const HEARTBEAT_INTERVAL_EXPECTED_MS = 10000;

function respuesta(res, status, datos) {
  return res.status(status).json(datos);
}

function ahoraTimestamp() {
  return Timestamp.now();
}

function ahoraMs() {
  return Date.now();
}

function timestampMs(valor) {
  if (!valor) return null;

  if (typeof valor.toMillis === "function") {
    return valor.toMillis();
  }

  if (valor._seconds !== undefined) {
    return (
      Number(valor._seconds) * 1000 +
      Math.floor(Number(valor._nanoseconds || 0) / 1000000)
    );
  }

  return null;
}

function minutosCompletos(ms) {
  return Math.floor(Math.max(0, ms) / 60000);
}

function generarIdRealizacion() {
  return db.collection("realizaciones_tareas").doc().id;
}

function generarIdSesion() {
  return db.collection("sesiones_tareas").doc().id;
}

function faseCoincide(faseTarea, faseUsuario) {
  const tarea = String(faseTarea ?? "").trim();
  const usuario = String(faseUsuario ?? "").trim();

  return (
    tarea === usuario ||
    (tarea === "1" && usuario === "Fase 1") ||
    (tarea === "Fase 1" && usuario === "1") ||
    (tarea === "2" && usuario === "Fase 2") ||
    (tarea === "Fase 2" && usuario === "2")
  );
}

async function verificarToken(req) {
  const encabezado = req.headers.authorization || "";

  if (!encabezado.startsWith("Bearer ")) {
    throw new Error("NO_AUTORIZADO");
  }

  const token = encabezado.substring(7).trim();

  if (!token) {
    throw new Error("NO_AUTORIZADO");
  }

  return await auth.verifyIdToken(token);
}

async function obtenerUsuario(uid) {
  const referencia = db.collection("users").doc(uid);
  const snapshot = await referencia.get();

  if (!snapshot.exists) {
    throw new Error("USUARIO_NO_EXISTE");
  }

  const usuario = snapshot.data();

  if (usuario.activo !== true) {
    throw new Error("USUARIO_INACTIVO");
  }

  return {
    referencia,
    datos: usuario
  };
}

async function obtenerTarea(tareaId) {
  if (!tareaId || typeof tareaId !== "string") {
    throw new Error("TAREA_INVALIDA");
  }

  const referencia = db.collection("tareas").doc(tareaId);
  const snapshot = await referencia.get();

  if (!snapshot.exists) {
    throw new Error("TAREA_NO_EXISTE");
  }

  return {
    referencia,
    datos: snapshot.data()
  };
}

function tareaRetirada(tarea) {
  return tarea.retirada === true;
}

function validarFase(tarea, usuario) {
  if (!faseCoincide(tarea.fase, usuario.fase)) {
    throw new Error("TAREA_NO_DISPONIBLE");
  }
}

function obtenerTiempoRequeridoMs(tarea) {
  const minutos = Number(tarea.tiempo_requerido);

  if (!Number.isFinite(minutos) || minutos <= 0) {
    throw new Error("TIEMPO_INVALIDO");
  }

  return Math.floor(minutos * 60000);
}

function obtenerRealizacionPublica(realizacion) {
  return {
    realizacion_id: realizacion.realizacion_id,
    tarea_id: realizacion.tarea_id,
    estado: realizacion.estado,
    fecha_inicio: realizacion.fecha_inicio,
    fecha_vencimiento: realizacion.fecha_vencimiento,
    tiempo_requerido: realizacion.tiempo_requerido,
    tiempo_activo_valido:
      Number(realizacion.tiempo_activo_valido || 0),
    tiempo_adicional:
      Number(realizacion.tiempo_adicional || 0),
    momento_requerido_alcanzado:
      realizacion.momento_requerido_alcanzado || null
  };
}

function obtenerSesionPublica(sesion) {
  return {
    activa: sesion.activa === true,
    instancia_id: sesion.instancia_id || null,
    tiempo_activo_valido:
      Number(sesion.tiempo_activo_valido || 0),
    tiempo_adicional:
      Number(sesion.tiempo_adicional || 0),
    tiempo_total_valido:
      Number(sesion.tiempo_activo_valido || 0) +
      Number(sesion.tiempo_adicional || 0),
    tiempo_requerido_alcanzado:
      sesion.tiempo_requerido_alcanzado === true,
    bloqueada: sesion.bloqueada === true
  };
}

function tiempoContableHastaAhora(
  sesion,
  realizacion,
  ahora
) {
  if (!sesion || sesion.activa !== true) {
    return 0;
  }

  const ahoraNumero = ahora.getTime();

  const inicio =
    timestampMs(sesion.inicio_actual) ??
    timestampMs(sesion.ultimo_punto_conteo) ??
    timestampMs(realizacion.fecha_inicio);

  if (!inicio) {
    return 0;
  }

  const ultimoHeartbeat =
    timestampMs(sesion.ultimo_heartbeat_valido);

  const ultimaInteraccion =
    timestampMs(sesion.ultima_interaccion_valida);

  const ultimoPunto =
    timestampMs(sesion.ultimo_punto_conteo);

  if (!ultimoPunto) {
    return 0;
  }

  let limite = ahoraNumero;

  if (ultimoHeartbeat !== null) {
    limite = Math.min(
      limite,
      ultimoHeartbeat + MAX_ACTIVE_GAP_MS
    );
  }

  if (ultimaInteraccion !== null) {
    limite = Math.min(
      limite,
      ultimaInteraccion + ACTIVITY_WINDOW_MS
    );
  } else {
    limite = Math.min(
      limite,
      inicio + ACTIVITY_WINDOW_MS
    );
  }

  const diferencia = limite - ultimoPunto;

  if (diferencia <= 0) {
    return 0;
  }

  return diferencia;
}

function distribuirTiempo(
  tiempoBaseRequerido,
  tiempoBaseAdicional,
  tiempoNuevo
) {
  const requeridoActual = Math.max(
    0,
    Number(tiempoBaseRequerido || 0)
  );

  const adicionalActual = Math.max(
    0,
    Number(tiempoBaseAdicional || 0)
  );

  const restanteRequerido = Math.max(
    0,
    tiempoNuevo
  );

  const requeridoMaximo =
    Number.MAX_SAFE_INTEGER;

  const nuevoRequerido = Math.min(
    requeridoActual + restanteRequerido,
    requeridoMaximo
  );

  return {
    requerido: nuevoRequerido,
    adicional: adicionalActual
  };
}

function calcularNuevoTiempo(
  sesion,
  realizacion,
  tarea,
  ahora
) {
  const requerido = obtenerTiempoRequeridoMs(tarea);

  const tiempoRequeridoActual =
    Math.min(
      requerido,
      Number(
        sesion.tiempo_activo_valido || 0
      )
    );

  const adicionalActual =
    Number(
      sesion.tiempo_adicional ??
      realizacion.tiempo_adicional ??
      0
    );

  const pendiente =
    tiempoContableHastaAhora(
      sesion,
      realizacion,
      ahora
    );

  const restanteRequerido =
    Math.max(
      0,
      requerido - tiempoRequeridoActual
    );

  const usadoParaRequerido =
    Math.min(
      pendiente,
      restanteRequerido
    );

  const exceso =
    Math.max(
      0,
      pendiente - usadoParaRequerido
    );

  const nuevoTiempoRequerido =
    tiempoRequeridoActual +
    usadoParaRequerido;

  const nuevoTiempoAdicional =
    adicionalActual +
    exceso;

  return {
    requerido,
    tiempoRequerido: nuevoTiempoRequerido,
    tiempoAdicional: nuevoTiempoAdicional,
    tiempoPendiente: pendiente,
    alcanzado:
      nuevoTiempoRequerido >= requerido
  };
}

async function cerrarRealizacionPorCaducidad(
  realizacionRef,
  realizacion,
  usuario,
  tarea,
  ahora
) {
  const ahoraMsValue = ahora.getTime();

  const vencimiento =
    timestampMs(
      realizacion.fecha_vencimiento
    );

  if (
    realizacion.estado !== "pendiente" ||
    vencimiento === null ||
    ahoraMsValue < vencimiento
  ) {
    return {
      caducada: false,
      nuevaRealizacion: null
    };
  }

  const historialRef = db
    .collection("historial_realizaciones")
    .doc(realizacion.realizacion_id);

  const esRetirada =
    tareaRetirada(tarea);

  const nuevaRef = !esRetirada
    ? db
        .collection("realizaciones_tareas")
        .doc(generarIdRealizacion())
    : null;

  await db.runTransaction(
    async transaction => {
      const actual =
        await transaction.get(
          realizacionRef
        );

      if (!actual.exists) {
        throw new Error(
          "REALIZACION_NO_EXISTE"
        );
      }

      const datosActuales =
        actual.data();

      if (
        datosActuales.estado !==
        "pendiente"
      ) {
        return;
      }

      const vencimientoActual =
        timestampMs(
          datosActuales.fecha_vencimiento
        );

      if (
        vencimientoActual === null ||
        ahoraMsValue < vencimientoActual
      ) {
        return;
      }

      const datosHistorial = {
        realizacion_id:
          datosActuales.realizacion_id,
        usuario_id:
          usuario.usuario_id ||
          realizacion.usuario_id,
        email:
          usuario.email ||
          realizacion.email ||
          null,
        tarea_id:
          datosActuales.tarea_id,
        titulo_tarea:
          tarea.titulo || "",
        fase:
          usuario.fase ||
          tarea.fase ||
          null,
        fecha_inicio:
          datosActuales.fecha_inicio ||
          null,
        fecha_fin:
          ahora,
        ultima_actualizacion:
          ahora,
        fecha_vencimiento:
          datosActuales.fecha_vencimiento ||
          null,
        estado:
          esRetirada
            ? "retiro_estilo_hub"
            : "caducada",
        motivo_cierre:
          esRetirada
            ? "Tarea retirada con realización pendiente vencida"
            : "Vencimiento de realización",
        tiempo_requerido:
          datosActuales.tiempo_requerido ||
          0,
        tiempo_activo_valido:
          datosActuales.tiempo_activo_valido ||
          0,
        tiempo_adicional:
          datosActuales.tiempo_adicional ||
          0,
        momento_requerido_alcanzado:
          datosActuales.momento_requerido_alcanzado ||
          null,
        cantidad_pausas:
          datosActuales.cantidad_pausas ||
          0,
        cantidad_reanudaciones:
          datosActuales.cantidad_reanudaciones ||
          0,
        pausas_relevantes:
          datosActuales.pausas_relevantes ||
          0,
        reanudaciones_relevantes:
          datosActuales.reanudaciones_relevantes ||
          0,
        interrupciones_relevantes:
          datosActuales.interrupciones_relevantes ||
          0,
        cambios_visibilidad_relevantes:
          datosActuales.cambios_visibilidad_relevantes ||
          0,
        heartbeats_esperados:
          datosActuales.heartbeats_esperados ||
          0,
        heartbeats_recibidos:
          datosActuales.heartbeats_recibidos ||
          0,
        heartbeats_perdidos:
          datosActuales.heartbeats_perdidos ||
          0,
        ultimo_heartbeat_valido:
          datosActuales.ultimo_heartbeat_valido ||
          null,
        ultima_comunicacion_valida:
          datosActuales.ultima_comunicacion_valida ||
          null,
        eventos_actividad:
          datosActuales.eventos_actividad ||
          [],
        eventos_tecnicos:
          datosActuales.eventos_tecnicos ||
          []
      };

      transaction.set(
        historialRef,
        datosHistorial
      );

      transaction.update(
        realizacionRef,
        {
          estado:
            esRetirada
              ? "retiro_estilo_hub"
              : "caducada",
          fecha_fin:
            ahora,
          ultima_actualizacion:
            ahora,
          motivo_cierre:
            esRetirada
              ? "Tarea retirada con realización pendiente vencida"
              : "Vencimiento de realización"
        }
      );

      if (nuevaRef) {
        const fechaVencimiento =
          Timestamp.fromMillis(
            ahoraMsValue +
              7 * 24 * 60 * 60 * 1000
          );

        transaction.set(
          nuevaRef,
          {
            realizacion_id:
              nuevaRef.id,
            usuario_id:
              usuario.usuario_id,
            email:
              usuario.email || null,
            tarea_id:
              datosActuales.tarea_id,
            titulo_tarea:
              tarea.titulo || "",
            fase:
              usuario.fase ||
              tarea.fase ||
              null,
            fecha_inicio:
              ahora,
            fecha_vencimiento:
              fechaVencimiento,
            fecha_fin:
              null,
            ultima_actualizacion:
              ahora,
            estado:
              "pendiente",
            motivo_cierre:
              null,
            tiempo_requerido:
              datosActuales.tiempo_requerido,
            tiempo_activo_valido:
              0,
            tiempo_adicional:
              0,
            momento_requerido_alcanzado:
              null,
            cantidad_pausas:
              0,
            cantidad_reanudaciones:
              0,
            pausas_relevantes:
              0,
            reanudaciones_relevantes:
              0,
            interrupciones_relevantes:
              0,
            cambios_visibilidad_relevantes:
              0,
            heartbeats_esperados:
              0,
            heartbeats_recibidos:
              0,
            heartbeats_perdidos:
              0,
            ultimo_heartbeat_valido:
              null,
            ultima_comunicacion_valida:
              null,
            eventos_actividad:
              [],
            eventos_tecnicos:
              []
          }
        );
      }
    }
  );

  return {
    caducada: true,
    nuevaRealizacion: nuevaRef
      ? {
          referencia: nuevaRef
        }
      : null
  };
}

async function obtenerOcrearRealizacion(
  uid,
  usuario,
  tareaId,
  tarea,
  permitirCrear
) {
  const realizacionesRef =
    db.collection(
      "realizaciones_tareas"
    );

  const existentes =
    await realizacionesRef
      .where(
        "usuario_id",
        "==",
        uid
      )
      .where(
        "tarea_id",
        "==",
        tareaId
      )
      .where(
        "estado",
        "==",
        "pendiente"
      )
      .limit(1)
      .get();

  if (!existentes.empty) {
    const doc =
      existentes.docs[0];

    return {
      referencia: doc.ref,
      datos: doc.data(),
      creada: false
    };
  }

  if (!permitirCrear) {
    throw new Error(
      "TAREA_NO_DISPONIBLE"
    );
  }

  const ahora =
    ahoraTimestamp();

  const fechaVencimiento =
    Timestamp.fromMillis(
      ahoraMs() +
        7 * 24 * 60 * 60 * 1000
    );

  const nuevaRef =
    realizacionesRef.doc(
      generarIdRealizacion()
    );

  const datos = {
    realizacion_id:
      nuevaRef.id,
    usuario_id:
      uid,
    email:
      usuario.email || null,
    tarea_id:
      tareaId,
    titulo_tarea:
      tarea.titulo || "",
    fase:
      usuario.fase ||
      tarea.fase ||
      null,
    fecha_inicio:
      ahora,
    fecha_fin:
      null,
    ultima_actualizacion:
      ahora,
    fecha_vencimiento:
      fechaVencimiento,
    estado:
      "pendiente",
    motivo_cierre:
      null,
    tiempo_requerido:
      Number(
        tarea.tiempo_requerido
      ),
    tiempo_activo_valido:
      0,
    tiempo_adicional:
      0,
    momento_requerido_alcanzado:
      null,
    cantidad_pausas:
      0,
    cantidad_reanudaciones:
      0,
    pausas_relevantes:
      0,
    reanudaciones_relevantes:
      0,
    interrupciones_relevantes:
      0,
    cambios_visibilidad_relevantes:
      0,
    heartbeats_esperados:
      0,
    heartbeats_recibidos:
      0,
    heartbeats_perdidos:
      0,
    ultimo_heartbeat_valido:
      null,
    ultima_comunicacion_valida:
      null,
    eventos_actividad:
      [],
    eventos_tecnicos:
      []
  };

  await nuevaRef.create(
    datos
  );

  return {
    referencia:
      nuevaRef,
    datos,
    creada: true
  };
}

async function obtenerSesionActivaUsuario(
  uid,
  excluirSesionId = null
) {
  const snapshot =
    await db
      .collection(
        "sesiones_tareas"
      )
      .where(
        "usuario_id",
        "==",
        uid
      )
      .where(
        "activa",
        "==",
        true
      )
      .limit(10)
      .get();

  for (
    const doc of snapshot.docs
  ) {
    if (
      doc.id ===
      excluirSesionId
    ) {
      continue;
    }

    return {
      referencia:
        doc.ref,
      datos:
        doc.data()
    };
  }

  return null;
}

async function registrarTiempoSesion(
  transaction,
  sesionRef,
  sesion,
  realizacionRef,
  realizacion,
  tarea,
  ahora
) {
  const calculo =
    calcularNuevoTiempo(
      sesion,
      realizacion,
      tarea,
      ahora
    );

  const requerido =
    calculo.requerido;

  const datosSesion = {
    tiempo_activo_valido:
      calculo.tiempoRequerido,
    tiempo_adicional:
      calculo.tiempoAdicional,
    ultimo_punto_conteo:
      ahora,
    ultima_actualizacion:
      ahora,
    ultima_comunicacion_valida:
      ahora
  };

  if (
    calculo.alcanzado &&
    !sesion.tiempo_requerido_alcanzado
  ) {
    datosSesion.tiempo_requerido_alcanzado =
      true;

    datosSesion.momento_requerido_alcanzado =
      ahora;
  }

  transaction.update(
    sesionRef,
    datosSesion
  );

  const datosRealizacion = {
    tiempo_activo_valido:
      calculo.tiempoRequerido,
    tiempo_adicional:
      calculo.tiempoAdicional,
    ultima_actualizacion:
      ahora
  };

  if (
    calculo.alcanzado &&
    !realizacion.momento_requerido_alcanzado
  ) {
    datosRealizacion.momento_requerido_alcanzado =
      ahora;
  }

  transaction.update(
    realizacionRef,
    datosRealizacion
  );

  return {
    requerido,
    tiempoRequerido:
      calculo.tiempoRequerido,
    tiempoAdicional:
      calculo.tiempoAdicional,
    alcanzado:
      calculo.alcanzado,
    tiempoPendiente:
      calculo.tiempoPendiente
  };
}

async function manejarInicio(
  uid,
  usuario,
  tareaId,
  tarea,
  instanciaId
) {
  if (
    !instanciaId ||
    typeof instanciaId !== "string"
  ) {
    throw new Error(
      "INSTANCIA_INVALIDA"
    );
  }

  const retirada =
    tareaRetirada(tarea);

  const realizacionEncontrada =
    await obtenerOcrearRealizacion(
      uid,
      usuario,
      tareaId,
      tarea,
      !retirada
    );

  let realizacionRef =
    realizacionEncontrada.referencia;

  let realizacion =
    realizacionEncontrada.datos;

  const ahora =
    ahoraTimestamp();

  const vencimiento =
    timestampMs(
      realizacion.fecha_vencimiento
    );

  if (
    realizacion.estado ===
      "pendiente" &&
    vencimiento !== null &&
    ahoraMs() >= vencimiento
  ) {
    const resultadoCaducidad =
      await cerrarRealizacionPorCaducidad(
        realizacionRef,
        realizacion,
        usuario,
        {
          ...tarea,
          tarea_id:
            tareaId
        },
        ahora
      );

    if (
      resultadoCaducidad.nuevaRealizacion
    ) {
      realizacionRef =
        resultadoCaducidad
          .nuevaRealizacion
          .referencia;

      const nuevaSnapshot =
        await realizacionRef.get();

      if (
        !nuevaSnapshot.exists
      ) {
        throw new Error(
          "REALIZACION_NO_EXISTE"
        );
      }

      realizacion =
        nuevaSnapshot.data();
    } else {
      throw new Error(
        "TAREA_NO_DISPONIBLE"
      );
    }
  }

  const sesionExistente =
    await db
      .collection(
        "sesiones_tareas"
      )
      .where(
        "realizacion_id",
        "==",
        realizacion.realizacion_id
      )
      .where(
        "activa",
        "==",
        true
      )
      .limit(1)
      .get();

  if (
    !sesionExistente.empty
  ) {
    const sesionDoc =
      sesionExistente.docs[0];

    const sesion =
      sesionDoc.data();

    if (
      sesion.instancia_id !==
      instanciaId
    ) {
      throw new Error(
        "SESION_BLOQUEADA"
      );
    }

    return {
      realizacion,
      sesion
    };
  }

  const otraSesion =
    await obtenerSesionActivaUsuario(
      uid
    );

  if (otraSesion) {
    throw new Error(
      "OTRA_TAREA_ACTIVA"
    );
  }

  const sesionRef =
    db
      .collection(
        "sesiones_tareas"
      )
      .doc(generarIdSesion());

  const datosSesion = {
    sesion_id:
      sesionRef.id,
    realizacion_id:
      realizacion.realizacion_id,
    usuario_id:
      uid,
    tarea_id:
      tareaId,
    instancia_id:
      instanciaId,
    activa:
      true,
    bloqueada:
      false,
    inicio_actual:
      ahora,
    ultimo_punto_conteo:
      ahora,
    ultima_interaccion_valida:
      null,
    ultimo_heartbeat_valido:
      ahora,
    ultima_comunicacion_valida:
      ahora,
    tiempo_activo_valido:
      Number(
        realizacion.tiempo_activo_valido ||
        0
      ),
    tiempo_adicional:
      Number(
        realizacion.tiempo_adicional ||
        0
      ),
    tiempo_requerido_alcanzado:
      !!realizacion.momento_requerido_alcanzado,
    momento_requerido_alcanzado:
      realizacion.momento_requerido_alcanzado ||
      null,
    cantidad_pausas:
      0,
    cantidad_reanudaciones:
      Number(
        realizacion.cantidad_reanudaciones ||
        0
      ),
    heartbeats_esperados:
      0,
    heartbeats_recibidos:
      0,
    heartbeats_perdidos:
      0,
    fecha_inicio:
      ahora,
    ultima_actualizacion:
      ahora
  };

  await db.runTransaction(
    async transaction => {
      const realizacionActual =
        await transaction.get(
          realizacionRef
        );

      if (
        !realizacionActual.exists
      ) {
        throw new Error(
          "REALIZACION_NO_EXISTE"
        );
      }

      const datosActuales =
        realizacionActual.data();

      if (
        datosActuales.estado !==
        "pendiente"
      ) {
        throw new Error(
          "REALIZACION_CERRADA"
        );
      }

      transaction.set(
        sesionRef,
        datosSesion
      );

      transaction.update(
        realizacionRef,
        {
          ultima_actualizacion:
            ahora,
          cantidad_reanudaciones:
            Number(
              datosActuales.cantidad_reanudaciones ||
              0
            ) + 1
        }
      );
    }
  );

  return {
    realizacion: {
      ...realizacion,
      ultima_actualizacion:
        ahora
    },
    sesion:
      datosSesion
  };
}

async function obtenerSesionActual(
  uid,
  tareaId,
  instanciaId
) {
  if (
    !instanciaId ||
    typeof instanciaId !== "string"
  ) {
    throw new Error(
      "INSTANCIA_INVALIDA"
    );
  }

  const sesionQuery =
    await db
      .collection(
        "sesiones_tareas"
      )
      .where(
        "usuario_id",
        "==",
        uid
      )
      .where(
        "tarea_id",
        "==",
        tareaId
      )
      .where(
        "activa",
        "==",
        true
      )
      .limit(10)
      .get();

  for (
    const doc of sesionQuery.docs
  ) {
    const sesion =
      doc.data();

    if (
      sesion.instancia_id ===
      instanciaId
    ) {
      return {
        referencia:
          doc.ref,
        datos:
          sesion
      };
    }
  }

  if (
    !sesionQuery.empty
  ) {
    throw new Error(
      "SESION_BLOQUEADA"
    );
  }

  throw new Error(
    "SESION_NO_ACTIVA"
  );
}

async function manejarActividad(
  uid,
  tareaId,
  tarea,
  instanciaId,
  tipoActividad
) {
  const sesionActual =
    await obtenerSesionActual(
      uid,
      tareaId,
      instanciaId
    );

  const sesionRef =
    sesionActual.referencia;

  const sesion =
    sesionActual.datos;

  const realizacionRef =
    db
      .collection(
        "realizaciones_tareas"
      )
      .doc(
        sesion.realizacion_id
      );

  const ahora =
    ahoraTimestamp();

  await db.runTransaction(
    async transaction => {
      const sesionSnapshot =
        await transaction.get(
          sesionRef
        );

      const realizacionSnapshot =
        await transaction.get(
          realizacionRef
        );

      if (
        !sesionSnapshot.exists
      ) {
        throw new Error(
          "SESION_NO_ACTIVA"
        );
      }

      if (
        !realizacionSnapshot.exists
      ) {
        throw new Error(
          "REALIZACION_NO_EXISTE"
        );
      }

      const sesionActualizada =
        sesionSnapshot.data();

      const realizacion =
        realizacionSnapshot.data();

      if (
        sesionActualizada.instancia_id !==
        instanciaId
      ) {
        throw new Error(
          "SESION_BLOQUEADA"
        );
      }

      if (
        sesionActualizada.activa !==
        true
      ) {
        throw new Error(
          "SESION_PAUSADA"
        );
      }

      if (
        realizacion.estado !==
        "pendiente"
      ) {
        throw new Error(
          "REALIZACION_CERRADA"
        );
      }

      const vencimiento =
        timestampMs(
          realizacion.fecha_vencimiento
        );

      if (
        vencimiento !== null &&
        ahoraMs() >= vencimiento
      ) {
        throw new Error(
          "REALIZACION_VENCIDA"
        );
      }

      const ultimaComunicacion =
        timestampMs(
          sesionActualizada
            .ultima_comunicacion_valida
        );

      if (
        ultimaComunicacion !== null &&
        ahoraMs() -
          ultimaComunicacion >
          MAX_ACTIVE_GAP_MS
      ) {
        transaction.update(
          sesionRef,
          {
            activa:
              false,
            ultima_actualizacion:
              ahora,
            heartbeats_perdidos:
              Number(
                sesionActualizada
                  .heartbeats_perdidos ||
                0
              ) + 1,
            eventos_tecnicos:
              FieldValue.arrayUnion({
                tipo:
                  "interrupcion",
                motivo:
                  "perdida_comunicacion",
                fecha_hora:
                  ahora
              })
          }
        );

        transaction.update(
          realizacionRef,
          {
            ultima_actualizacion:
              ahora,
            interrupciones_relevantes:
              Number(
                realizacion
                  .interrupciones_relevantes ||
                0
              ) + 1
          }
        );

        throw new Error(
          "SESION_PAUSADA"
        );
      }

      const calculo =
        await registrarTiempoSesion(
          transaction,
          sesionRef,
          sesionActualizada,
          realizacionRef,
          realizacion,
          tarea,
          ahora
        );

      transaction.update(
        sesionRef,
        {
          ultima_interaccion_valida:
            ahora,
          ultima_comunicacion_valida:
            ahora,
          tipo_ultima_actividad:
            typeof tipoActividad ===
              "string"
              ? tipoActividad.substring(
                  0,
                  50
                )
              : "interaccion"
        }
      );

      transaction.update(
        realizacionRef,
        {
          eventos_actividad:
            FieldValue.arrayUnion({
              tipo:
                typeof tipoActividad ===
                  "string"
                  ? tipoActividad.substring(
                      0,
                      50
                    )
                  : "interaccion",
              fecha_hora:
                ahora
            })
        }
      );

      if (
        calculo.alcanzado
      ) {
        transaction.update(
          sesionRef,
          {
            tiempo_requerido_alcanzado:
              true,
            momento_requerido_alcanzado:
              sesionActualizada
                .momento_requerido_alcanzado ||
              ahora
          }
        );
      }
    }
  );

  return {
    ok: true
  };
}

async function manejarHeartbeat(
  uid,
  tareaId,
  instanciaId
) {
  const sesionActual =
    await obtenerSesionActual(
      uid,
      tareaId,
      instanciaId
    );

  const sesionRef =
    sesionActual.referencia;

  const ahora =
    ahoraTimestamp();

  const realizacionRef =
    db
      .collection(
        "realizaciones_tareas"
      )
      .doc(
        sesionActual.datos
          .realizacion_id
      );

  await db.runTransaction(
    async transaction => {
      const sesionSnapshot =
        await transaction.get(
          sesionRef
        );

      const realizacionSnapshot =
        await transaction.get(
          realizacionRef
        );

      if (
        !sesionSnapshot.exists
      ) {
        throw new Error(
          "SESION_NO_ACTIVA"
        );
      }

      if (
        !realizacionSnapshot.exists
      ) {
        throw new Error(
          "REALIZACION_NO_EXISTE"
        );
      }

      const sesion =
        sesionSnapshot.data();

      const realizacion =
        realizacionSnapshot.data();

      if (
        sesion.instancia_id !==
        instanciaId
      ) {
        throw new Error(
          "SESION_BLOQUEADA"
        );
      }

      if (
        sesion.activa !==
        true
      ) {
        throw new Error(
          "SESION_PAUSADA"
        );
      }

      if (
        realizacion.estado !==
        "pendiente"
      ) {
        throw new Error(
          "REALIZACION_CERRADA"
        );
      }

      const vencimiento =
        timestampMs(
          realizacion.fecha_vencimiento
        );

      if (
        vencimiento !== null &&
        ahoraMs() >= vencimiento
      ) {
        throw new Error(
          "REALIZACION_VENCIDA"
        );
      }

      const ultimoHeartbeat =
        timestampMs(
          sesion.ultimo_heartbeat_valido
        );

      const diferencia =
        ultimoHeartbeat === null
          ? 0
          : ahoraMs() -
            ultimoHeartbeat;

      if (
        diferencia >
        MAX_ACTIVE_GAP_MS
      ) {
        transaction.update(
          sesionRef,
          {
            activa:
              false,
            ultima_actualizacion:
              ahora,
            heartbeats_perdidos:
              Number(
                sesion.heartbeats_perdidos ||
                0
              ) + 1,
            ultima_comunicacion_valida:
              ahora
          }
        );

        transaction.update(
          realizacionRef,
          {
            ultima_actualizacion:
              ahora,
            interrupciones_relevantes:
              Number(
                realizacion
                  .interrupciones_relevantes ||
                0
              ) + 1
          }
        );

        throw new Error(
          "SESION_PAUSADA"
        );
      }

      const calculo =
        await registrarTiempoSesion(
          transaction,
          sesionRef,
          sesion,
          realizacionRef,
          realizacion,
          {
            tiempo_requerido:
              realizacion.tiempo_requerido
          },
          ahora
        );

      let heartbeatsEsperados =
        Number(
          sesion.heartbeats_esperados ||
          0
        );

      if (
        ultimoHeartbeat !== null
      ) {
        const intervalos =
          Math.floor(
            diferencia /
              HEARTBEAT_INTERVAL_EXPECTED_MS
          );

        if (
          intervalos > 0
        ) {
          heartbeatsEsperados +=
            intervalos;
        } else {
          heartbeatsEsperados += 1;
        }
      } else {
        heartbeatsEsperados +=
          1;
      }

      const recibidos =
        Number(
          sesion.heartbeats_recibidos ||
          0
        ) + 1;

      const perdidos =
        Math.max(
          0,
          heartbeatsEsperados -
            recibidos
        );

      transaction.update(
        sesionRef,
        {
          ultimo_heartbeat_valido:
            ahora,
          ultima_comunicacion_valida:
            ahora,
          heartbeats_recibidos:
            recibidos,
          heartbeats_esperados:
            heartbeatsEsperados,
          heartbeats_perdidos:
            perdidos,
          tiempo_requerido_alcanzado:
            calculo.alcanzado ||
            sesion.tiempo_requerido_alcanzado ===
              true,
          momento_requerido_alcanzado:
            calculo.alcanzado
              ? sesion.momento_requerido_alcanzado ||
                ahora
              : sesion.momento_requerido_alcanzado ||
                null
        }
      );

      transaction.update(
        realizacionRef,
        {
          ultimo_heartbeat_valido:
            ahora,
          ultima_comunicacion_valida:
            ahora,
          heartbeats_recibidos:
            Number(
              realizacion
                .heartbeats_recibidos ||
              0
            ) + 1,
          heartbeats_esperados:
            heartbeatsEsperados,
          heartbeats_perdidos:
            perdidos
        }
      );
    }
  );

  return {
    ok: true
  };
}

async function manejarPausa(
  uid,
  tareaId,
  instanciaId,
  motivo = "pausa"
) {
  const sesionQuery =
    await db
      .collection(
        "sesiones_tareas"
      )
      .where(
        "usuario_id",
        "==",
        uid
      )
      .where(
        "tarea_id",
        "==",
        tareaId
      )
      .where(
        "activa",
        "==",
        true
      )
      .limit(10)
      .get();

  if (
    sesionQuery.empty
  ) {
    return {
      ok: true,
      yaPausada: true
    };
  }

  let sesionDoc = null;

  for (
    const doc of sesionQuery.docs
  ) {
    if (
      doc.data()
        .instancia_id ===
      instanciaId
    ) {
      sesionDoc = doc;
      break;
    }
  }

  if (!sesionDoc) {
    throw new Error(
      "SESION_BLOQUEADA"
    );
  }

  const sesionRef =
    sesionDoc.ref;

  const ahora =
    ahoraTimestamp();

  const realizacionRef =
    db
      .collection(
        "realizaciones_tareas"
      )
      .doc(
        sesionDoc.data()
          .realizacion_id
      );

  await db.runTransaction(
    async transaction => {
      const sesionSnapshot =
        await transaction.get(
          sesionRef
        );

      const realizacionSnapshot =
        await transaction.get(
          realizacionRef
        );

      if (
        !sesionSnapshot.exists
      ) {
        return;
      }

      if (
        !realizacionSnapshot.exists
      ) {
        throw new Error(
          "REALIZACION_NO_EXISTE"
        );
      }

      const sesion =
        sesionSnapshot.data();

      const realizacion =
        realizacionSnapshot.data();

      if (
        sesion.instancia_id !==
        instanciaId
      ) {
        throw new Error(
          "SESION_BLOQUEADA"
        );
      }

      if (
        sesion.activa !==
        true
      ) {
        return;
      }

      if (
        realizacion.estado !==
        "pendiente"
      ) {
        throw new Error(
          "REALIZACION_CERRADA"
        );
      }

      const vencimiento =
        timestampMs(
          realizacion.fecha_vencimiento
        );

      if (
        vencimiento !== null &&
        ahoraMs() >= vencimiento
      ) {
        throw new Error(
          "REALIZACION_VENCIDA"
        );
      }

      const calculo =
        calcularNuevoTiempo(
          sesion,
          realizacion,
          {
            tiempo_requerido:
              realizacion.tiempo_requerido
          },
          ahora
        );

      transaction.update(
        sesionRef,
        {
          activa:
            false,
          tiempo_activo_valido:
            calculo.tiempoRequerido,
          tiempo_adicional:
            calculo.tiempoAdicional,
          ultimo_punto_conteo:
            ahora,
          ultima_actualizacion:
            ahora,
          ultima_comunicacion_valida:
            ahora,
          cantidad_pausas:
            Number(
              sesion.cantidad_pausas ||
              0
            ) + 1,
          tiempo_requerido_alcanzado:
            calculo.alcanzado ||
            sesion.tiempo_requerido_alcanzado ===
              true,
          momento_requerido_alcanzado:
            calculo.alcanzado
              ? sesion.momento_requerido_alcanzado ||
                ahora
              : sesion.momento_requerido_alcanzado ||
                null
        }
      );

      transaction.update(
        realizacionRef,
        {
          tiempo_activo_valido:
            calculo.tiempoRequerido,
          tiempo_adicional:
            calculo.tiempoAdicional,
          ultima_actualizacion:
            ahora,
          cantidad_pausas:
            Number(
              realizacion.cantidad_pausas ||
              0
            ) + 1,
          pausas_relevantes:
            Number(
              realizacion.pausas_relevantes ||
              0
            ) + 1,
          momento_requerido_alcanzado:
            calculo.alcanzado
              ? realizacion.momento_requerido_alcanzado ||
                ahora
              : realizacion.momento_requerido_alcanzado ||
                null,
          eventos_actividad:
            FieldValue.arrayUnion({
              tipo:
                "pausa",
              fecha_hora:
                ahora,
              motivo:
                typeof motivo ===
                  "string"
                  ? motivo.substring(
                      0,
                      50
                    )
                  : "pausa"
            })
        }
      );
    }
  );

  return {
    ok: true
  };
}

async function manejarCompletar(
  uid,
  usuario,
  tareaId,
  tarea,
  instanciaId
) {
  const sesionQuery =
    await db
      .collection(
        "sesiones_tareas"
      )
      .where(
        "usuario_id",
        "==",
        uid
      )
      .where(
        "tarea_id",
        "==",
        tareaId
      )
      .limit(10)
      .get();

  if (
    sesionQuery.empty
  ) {
    throw new Error(
      "SESION_NO_EXISTE"
    );
  }

  let sesionDoc = null;

  for (
    const doc of sesionQuery.docs
  ) {
    if (
      doc.data()
        .instancia_id ===
      instanciaId
    ) {
      sesionDoc = doc;
      break;
    }
  }

  if (!sesionDoc) {
    throw new Error(
      "SESION_BLOQUEADA"
    );
  }

  const sesionRef =
    sesionDoc.ref;

  const realizacionRef =
    db
      .collection(
        "realizaciones_tareas"
      )
      .doc(
        sesionDoc.data()
          .realizacion_id
      );

  const historialRef =
    db
      .collection(
        "historial_realizaciones"
      )
      .doc(
        sesionDoc.data()
          .realizacion_id
      );

  const progresoRef =
    db
      .collection(
        "progreso_tareas"
      )
      .doc(
        `${uid}_${tareaId}`
      );

  const estadisticaRef =
    db
      .collection(
        "estadisticas_usuario"
      )
      .doc(uid);

  const ahora =
    ahoraTimestamp();

  let resultado = null;

  await db.runTransaction(
    async transaction => {
      const realizacionSnapshot =
        await transaction.get(
          realizacionRef
        );

      const sesionSnapshot =
        await transaction.get(
          sesionRef
        );

      const progresoSnapshot =
        await transaction.get(
          progresoRef
        );

      const estadisticaSnapshot =
        await transaction.get(
          estadisticaRef
        );

      if (
        !realizacionSnapshot.exists
      ) {
        throw new Error(
          "REALIZACION_NO_EXISTE"
        );
      }

      if (
        !sesionSnapshot.exists
      ) {
        throw new Error(
          "SESION_NO_EXISTE"
        );
      }

      const realizacion =
        realizacionSnapshot.data();

      const sesionActual =
        sesionSnapshot.data();

      if (
        realizacion.estado !==
        "pendiente"
      ) {
        throw new Error(
          "REALIZACION_YA_CERRADA"
        );
      }

      if (
        sesionActual.instancia_id !==
        instanciaId
      ) {
        throw new Error(
          "SESION_BLOQUEADA"
        );
      }

      const vencimiento =
        timestampMs(
          realizacion.fecha_vencimiento
        );

      if (
        vencimiento !== null &&
        ahoraMs() >= vencimiento
      ) {
        throw new Error(
          "REALIZACION_VENCIDA"
        );
      }

      let calculo;

      if (
        sesionActual.activa ===
        true
      ) {
        calculo =
          calcularNuevoTiempo(
            sesionActual,
            realizacion,
            tarea,
            ahora
          );
      } else {
        calculo = {
          requerido:
            obtenerTiempoRequeridoMs(
              tarea
            ),
          tiempoRequerido:
            Math.min(
              obtenerTiempoRequeridoMs(
                tarea
              ),
              Number(
                sesionActual
                  .tiempo_activo_valido ||
                0
              )
            ),
          tiempoAdicional:
            Number(
              sesionActual
                .tiempo_adicional ??
              realizacion
                .tiempo_adicional ??
              0
            ),
          tiempoPendiente:
            0
        };

        calculo.alcanzado =
          calculo.tiempoRequerido >=
          calculo.requerido;
      }

      if (
        calculo.tiempoRequerido <
        calculo.requerido
      ) {
        if (
          sesionActual.activa ===
          true
        ) {
          transaction.update(
            sesionRef,
            {
              tiempo_activo_valido:
                calculo.tiempoRequerido,
              tiempo_adicional:
                calculo.tiempoAdicional,
              ultimo_punto_conteo:
                ahora,
              ultima_actualizacion:
                ahora
            }
          );
        }

        transaction.update(
          realizacionRef,
          {
            tiempo_activo_valido:
              calculo.tiempoRequerido,
            tiempo_adicional:
              calculo.tiempoAdicional,
            ultima_actualizacion:
              ahora
          }
        );

        throw new Error(
          "TIEMPO_INSUFICIENTE"
        );
      }

      const tiempoValido =
        calculo.tiempoRequerido;

      const tiempoAdicional =
        calculo.tiempoAdicional;

      const datosRealizacionFinal = {
        estado:
          "completada",
        fecha_fin:
          ahora,
        ultima_actualizacion:
          ahora,
        tiempo_activo_valido:
          tiempoValido,
        tiempo_adicional:
          tiempoAdicional,
        momento_requerido_alcanzado:
          realizacion
            .momento_requerido_alcanzado ||
          ahora,
        motivo_cierre:
          "Tarea completada"
      };

      const datosHistorial = {
        realizacion_id:
          realizacion.realizacion_id,
        usuario_id:
          uid,
        email:
          usuario.email || null,
        tarea_id:
          tareaId,
        titulo_tarea:
          tarea.titulo || "",
        fase:
          usuario.fase ||
          tarea.fase ||
          null,
        fecha_inicio:
          realizacion.fecha_inicio ||
          null,
        fecha_fin:
          ahora,
        ultima_actualizacion:
          ahora,
        fecha_vencimiento:
          realizacion.fecha_vencimiento ||
          null,
        estado:
          "completada",
        motivo_cierre:
          "Tarea completada",
        tiempo_requerido:
          calculo.requerido,
        tiempo_activo_valido:
          tiempoValido,
        tiempo_adicional:
          tiempoAdicional,
        momento_requerido_alcanzado:
          realizacion
            .momento_requerido_alcanzado ||
          ahora,
        cantidad_pausas:
          realizacion.cantidad_pausas ||
          0,
        cantidad_reanudaciones:
          realizacion.cantidad_reanudaciones ||
          0,
        pausas_relevantes:
          realizacion.pausas_relevantes ||
          0,
        reanudaciones_relevantes:
          realizacion.reanudaciones_relevantes ||
          0,
        interrupciones_relevantes:
          realizacion.interrupciones_relevantes ||
          0,
        cambios_visibilidad_relevantes:
          realizacion.cambios_visibilidad_relevantes ||
          0,
        heartbeats_esperados:
          realizacion.heartbeats_esperados ||
          0,
        heartbeats_recibidos:
          realizacion.heartbeats_recibidos ||
          0,
        heartbeats_perdidos:
          realizacion.heartbeats_perdidos ||
          0,
        ultimo_heartbeat_valido:
          realizacion.ultimo_heartbeat_valido ||
          null,
        ultima_comunicacion_valida:
          realizacion.ultima_comunicacion_valida ||
          null,
        eventos_actividad:
          realizacion.eventos_actividad ||
          [],
        eventos_tecnicos:
          realizacion.eventos_tecnicos ||
          []
      };

      transaction.set(
        historialRef,
        datosHistorial
      );

      transaction.update(
        realizacionRef,
        datosRealizacionFinal
      );

      transaction.update(
        sesionRef,
        {
          activa:
            false,
          tiempo_activo_valido:
            tiempoValido,
          tiempo_adicional:
            tiempoAdicional,
          ultima_actualizacion:
            ahora,
          fecha_completada:
            ahora
        }
      );

      const progresoAnterior =
        progresoSnapshot.exists
          ? progresoSnapshot.data()
          : {};

      const vecesRealizada =
        Number(
          progresoAnterior
            .veces_realizada ||
          0
        ) + 1;

      const minutosRealizados =
        minutosCompletos(
          tiempoValido
        );

      transaction.set(
        progresoRef,
        {
          usuario_id:
            uid,
          email:
            usuario.email || null,
          tarea_id:
            tareaId,
          titulo_tarea:
            tarea.titulo || "",
          fecha_realizada:
            ahora,
          minutos_realizados:
            Number(
              progresoAnterior
                .minutos_realizados ||
              0
            ) +
            minutosRealizados,
          veces_realizada:
            vecesRealizada,
          ultima_realizacion_id:
            realizacion
              .realizacion_id
        },
        {
          merge: true
        }
      );

      const estadisticasAnteriores =
        estadisticaSnapshot.exists
          ? estadisticaSnapshot.data()
          : {};

      let diasTrabajados =
        Number(
          estadisticasAnteriores
            .dias_trabajados ||
          0
        );

      const ultimaFecha =
        timestampMs(
          estadisticasAnteriores
            .ultima_fecha_trabajo
        );

      const fechaActual =
        new Date(
          ahoraMs()
        );

      const fechaUltima =
        ultimaFecha
          ? new Date(
              ultimaFecha
            )
          : null;

      const mismoDia =
        fechaUltima &&
        fechaUltima.getUTCFullYear() ===
          fechaActual.getUTCFullYear() &&
        fechaUltima.getUTCMonth() ===
          fechaActual.getUTCMonth() &&
        fechaUltima.getUTCDate() ===
          fechaActual.getUTCDate();

      if (!mismoDia) {
        diasTrabajados +=
          1;
      }

      transaction.set(
        estadisticaRef,
        {
          usuario_id:
            uid,
          email:
            usuario.email || null,
          tareas_realizadas:
            Number(
              estadisticasAnteriores
                .tareas_realizadas ||
              0
            ) + 1,
          minutos_acumulados:
            Number(
              estadisticasAnteriores
                .minutos_acumulados ||
              0
            ) +
            minutosRealizados,
          dias_trabajados:
            diasTrabajados,
          ultima_fecha_trabajo:
            ahora
        },
        {
          merge: true
        }
      );

      resultado = {
        minutos_realizados:
          minutosRealizados,
        realizacion_id:
          realizacion
            .realizacion_id,
        tiempo_adicional:
          tiempoAdicional
      };
    }
  );

  return resultado;
}

async function obtenerEstado(
  uid,
  tareaId,
  instanciaId
) {
  const {
    datos: usuario
  } = await obtenerUsuario(
    uid
  );

  const tareaResultado =
    await obtenerTarea(
      tareaId
    );

  const tarea =
    tareaResultado.datos;

  validarFase(
    tarea,
    usuario
  );

  const retirada =
    tareaRetirada(
      tarea
    );

  const realizacionQuery =
    await db
      .collection(
        "realizaciones_tareas"
      )
      .where(
        "usuario_id",
        "==",
        uid
      )
      .where(
        "tarea_id",
        "==",
        tareaId
      )
      .where(
        "estado",
        "==",
        "pendiente"
      )
      .limit(1)
      .get();

  const tareaPublica = {
    id:
      tareaId,
    categoria:
      tarea.categoria || "",
    titulo:
      tarea.titulo || "",
    descripcion:
      tarea.descripcion || "",
    tiempo_requerido:
      Number(
        tarea.tiempo_requerido ||
        0
      ),
    link_url:
      tarea.link_url || null
  };

  if (
    realizacionQuery.empty
  ) {
    if (retirada) {
      throw new Error(
        "TAREA_NO_DISPONIBLE"
      );
    }

    return {
      ok: true,
      tarea:
        tareaPublica,
      realizacion:
        null,
      sesion:
        null
    };
  }

  const realizacionDoc =
    realizacionQuery.docs[0];

  const realizacion =
    realizacionDoc.data();

  const vencimiento =
    timestampMs(
      realizacion.fecha_vencimiento
    );

  if (
    vencimiento !== null &&
    ahoraMs() >= vencimiento
  ) {
    return {
      ok: true,
      tarea:
        tareaPublica,
      realizacion:
        obtenerRealizacionPublica(
          realizacion
        ),
      sesion:
        null,
      vencida:
        true
    };
  }

  let sesion = null;

  if (instanciaId) {
    const sesionQuery =
      await db
        .collection(
          "sesiones_tareas"
        )
        .where(
          "realizacion_id",
          "==",
          realizacion.realizacion_id
        )
        .where(
          "activa",
          "==",
          true
        )
        .limit(1)
        .get();

    if (
      !sesionQuery.empty
    ) {
      sesion =
        sesionQuery.docs[0]
          .data();

      if (
        sesion.instancia_id !==
        instanciaId
      ) {
        throw new Error(
          "SESION_BLOQUEADA"
        );
      }
    }
  }

  return {
    ok: true,
    tarea:
      tareaPublica,
    realizacion:
      obtenerRealizacionPublica(
        realizacion
      ),
    sesion:
      sesion
        ? obtenerSesionPublica(
            sesion
          )
        : null
  };
}

module.exports =
  async function handler(
    req,
    res
  ) {
    try {
      if (
        req.method !== "GET" &&
        req.method !== "POST"
      ) {
        return respuesta(
          res,
          405,
          {
            error:
              "Método no permitido."
          }
        );
      }

      const decoded =
        await verificarToken(
          req
        );

      const uid =
        decoded.uid;

      const {
        datos: usuario
      } =
        await obtenerUsuario(
          uid
        );

      if (
        req.method === "GET"
      ) {
        const tareaId =
          String(
            req.query?.id ||
              ""
          ).trim();

        const instanciaId =
          String(
            req.query
              ?.instancia_id ||
              ""
          ).trim();

        if (!tareaId) {
          return respuesta(
            res,
            400,
            {
              error:
                "No se pudo abrir la tarea."
            }
          );
        }

        const estado =
          await obtenerEstado(
            uid,
            tareaId,
            instanciaId
          );

        return respuesta(
          res,
          200,
          estado
        );
      }

      const body =
        req.body &&
        typeof req.body ===
          "object"
          ? req.body
          : {};

      const accion =
        String(
          body.accion || ""
        ).trim();

      const tareaId =
        String(
          body.tarea_id || ""
        ).trim();

      const instanciaId =
        String(
          body.instancia_id || ""
        ).trim();

      if (
        !accion ||
        !tareaId
      ) {
        return respuesta(
          res,
          400,
          {
            error:
              "Solicitud inválida."
          }
        );
      }

      const tareaResultado =
        await obtenerTarea(
          tareaId
        );

      const tarea =
        tareaResultado.datos;

      validarFase(
        tarea,
        usuario
      );

      if (
        accion ===
        "iniciar"
      ) {
        const resultado =
          await manejarInicio(
            uid,
            usuario,
            tareaId,
            tarea,
            instanciaId
          );

        return respuesta(
          res,
          200,
          {
            ok: true,
            realizacion:
              obtenerRealizacionPublica(
                resultado.realizacion
              ),
            sesion:
              obtenerSesionPublica(
                resultado.sesion
              )
          }
        );
      }

      if (
        accion ===
        "actividad"
      ) {
        const tipoActividad =
          typeof body.tipo_actividad ===
          "string"
            ? body.tipo_actividad
            : "interaccion";

        const resultado =
          await manejarActividad(
            uid,
            tareaId,
            tarea,
            instanciaId,
            tipoActividad
          );

        return respuesta(
          res,
          200,
          resultado
        );
      }

      if (
        accion ===
        "heartbeat"
      ) {
        const resultado =
          await manejarHeartbeat(
            uid,
            tareaId,
            instanciaId
          );

        return respuesta(
          res,
          200,
          resultado
        );
      }

      if (
        accion ===
        "pausar"
      ) {
        const motivo =
          typeof body.motivo ===
          "string"
            ? body.motivo
            : "pausa";

        const resultado =
          await manejarPausa(
            uid,
            tareaId,
            instanciaId,
            motivo
          );

        return respuesta(
          res,
          200,
          resultado
        );
      }

      if (
        accion ===
        "completar"
      ) {
        const resultado =
          await manejarCompletar(
            uid,
            usuario,
            tareaId,
            tarea,
            instanciaId
          );

        return respuesta(
          res,
          200,
          {
            ok: true,
            completada:
              true,
            minutos_realizados:
              resultado
                .minutos_realizados,
            tiempo_adicional:
              resultado
                .tiempo_adicional
          }
        );
      }

      if (
        accion ===
        "estado"
      ) {
        const estado =
          await obtenerEstado(
            uid,
            tareaId,
            instanciaId
          );

        return respuesta(
          res,
          200,
          estado
        );
      }

      return respuesta(
        res,
        400,
        {
          error:
            "Acción no válida."
        }
      );
    } catch (error) {
      const codigo =
        error?.message || "";

      if (
        codigo ===
          "NO_AUTORIZADO" ||
        codigo ===
          "auth/id-token-expired" ||
        codigo ===
          "auth/argument-error"
      ) {
        return respuesta(
          res,
          401,
          {
            error:
              "La sesión no es válida."
          }
        );
      }

      if (
        codigo ===
          "USUARIO_INACTIVO" ||
        codigo ===
          "USUARIO_NO_EXISTE"
      ) {
        return respuesta(
          res,
          403,
          {
            error:
              "No se puede acceder a esta tarea."
          }
        );
      }

      if (
        codigo ===
          "TAREA_NO_DISPONIBLE" ||
        codigo ===
          "TAREA_NO_EXISTE" ||
        codigo ===
          "REALIZACION_CERRADA" ||
        codigo ===
          "REALIZACION_YA_CERRADA" ||
        codigo ===
          "REALIZACION_VENCIDA"
      ) {
        return respuesta(
          res,
          403,
          {
            error:
              "Esta tarea ya no está disponible."
          }
        );
      }

      if (
        codigo ===
        "SESION_BLOQUEADA"
      ) {
        return respuesta(
          res,
          409,
          {
            error:
              "La tarea ya está abierta en otra ventana."
          }
        );
      }

      if (
        codigo ===
        "OTRA_TAREA_ACTIVA"
      ) {
        return respuesta(
          res,
          409,
          {
            error:
              "Ya tienes otra tarea activa."
          }
        );
      }

      if (
        codigo ===
          "SESION_NO_ACTIVA" ||
        codigo ===
          "SESION_PAUSADA"
      ) {
        return respuesta(
          res,
          409,
          {
            error:
              "La sesión de la tarea está pausada."
          }
        );
      }

      if (
        codigo ===
        "TIEMPO_INSUFICIENTE"
      ) {
        return respuesta(
          res,
          400,
          {
            error:
              "Todavía no se alcanzó el tiempo requerido."
          }
        );
      }

      if (
        codigo ===
          "TAREA_INVALIDA" ||
        codigo ===
          "TIEMPO_INVALIDO" ||
        codigo ===
          "INSTANCIA_INVALIDA"
      ) {
        return respuesta(
          res,
          400,
          {
            error:
              "La solicitud no es válida."
          }
        );
      }

      return respuesta(
        res,
        500,
        {
          error:
            "No se pudo procesar la tarea."
        }
      );
    }
  };
