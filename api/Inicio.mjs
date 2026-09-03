import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  getApps,
  initializeApp,
  cert
} = require("firebase-admin/app");

const {
  getAuth
} = require("firebase-admin/auth");

const {
  getFirestore
} = require("firebase-admin/firestore");


function getFirebaseAdmin() {
  if (getApps().length) {
    return getApps()[0];
  }

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
      privateKey: privateKey
    })
  });
}


function convertirFecha(valor) {
  if (!valor) {
    return null;
  }

  if (typeof valor.toDate === "function") {
    return valor.toDate().toISOString();
  }

  return valor;
}


export default async function handler(request) {

  if (request.method !== "GET") {
    return Response.json(
      {
        ok: false,
        error: "Método no permitido."
      },
      {
        status: 405
      }
    );
  }


  try {

    getFirebaseAdmin();

    const auth = getAuth();
    const db = getFirestore();


    const authorization =
      request.headers.get("authorization") || "";


    if (!authorization.startsWith("Bearer ")) {
      return Response.json(
        {
          ok: false,
          error: "No autorizado."
        },
        {
          status: 401
        }
      );
    }


    const idToken =
      authorization.substring(7).trim();


    if (!idToken) {
      return Response.json(
        {
          ok: false,
          error: "No autorizado."
        },
        {
          status: 401
        }
      );
    }


    let usuarioAutenticado;


    try {

      usuarioAutenticado =
        await auth.verifyIdToken(idToken);

    } catch (error) {

      return Response.json(
        {
          ok: false,
          error: "La sesión no es válida."
        },
        {
          status: 401
        }
      );

    }


    const uid =
      usuarioAutenticado.uid;


    const usuarioRef =
      db.collection("users").doc(uid);

    const estadisticasRef =
      db.collection("estadisticas_usuario").doc(uid);


    const [
      usuarioSnap,
      estadisticasSnap
    ] = await Promise.all([
      usuarioRef.get(),
      estadisticasRef.get()
    ]);


    if (!usuarioSnap.exists) {
      return Response.json(
        {
          ok: false,
          error: "No se encontró el usuario."
        },
        {
          status: 404
        }
      );
    }


    const usuario =
      usuarioSnap.data();


    if (usuario.activo === false) {
      return Response.json(
        {
          ok: false,
          error: "La cuenta no está activa."
        },
        {
          status: 403
        }
      );
    }


    const faseUsuario =
      String(
        usuario.fase || "Fase 1"
      ).trim();


    const estadisticas =
      estadisticasSnap.exists
        ? estadisticasSnap.data()
        : {};


    const tareasSnapshot =
      await db
        .collection("tareas")
        .where("activa", "==", true)
        .get();


    const tareas = [];


    tareasSnapshot.forEach(
      (documento) => {

        const datos =
          documento.data();


        const faseTarea =
          String(
            datos.fase ?? ""
          ).trim();


        const correspondeFase =
          faseTarea === faseUsuario ||
          (
            faseTarea === "1" &&
            faseUsuario === "Fase 1"
          ) ||
          (
            faseTarea === "Fase 1" &&
            faseUsuario === "1"
          );


        if (!correspondeFase) {
          return;
        }


        tareas.push({
          id: documento.id,

          categoria:
            String(
              datos.categoria || ""
            ),

          titulo:
            String(
              datos.titulo || ""
            ),

          descripcion:
            String(
              datos.descripcion || ""
            ),

          tiempo_requerido:
            Number(
              datos.tiempo_requerido || 0
            ),

          link_url:
            String(
              datos.link_url || ""
            ),

          orden:
            Number.isFinite(
              Number(datos.orden)
            )
              ? Number(datos.orden)
              : 999999
        });

      }
    );


    tareas.sort(
      (a, b) => {

        if (a.orden !== b.orden) {
          return a.orden - b.orden;
        }

        return a.titulo.localeCompare(
          b.titulo,
          "es"
        );

      }
    );


    const progresoSnapshot =
      await db
        .collection("progreso_tareas")
        .where("usuario_id", "==", uid)
        .get();


    const progreso = {};


    progresoSnapshot.forEach(
      (documento) => {

        const datos =
          documento.data();


        if (!datos.tarea_id) {
          return;
        }


        progreso[datos.tarea_id] = {

          fecha_realizada:
            convertirFecha(
              datos.fecha_realizada
            ),

          minutos_realizados:
            Number(
              datos.minutos_realizados || 0
            ),

          veces_realizada:
            Number(
              datos.veces_realizada || 0
            )

        };

      }
    );


    const tareasParaCliente =
      tareas.map(
        (tarea) => {

          const datosProgreso =
            progreso[tarea.id] || {};


          return {

            id:
              tarea.id,

            categoria:
              tarea.categoria,

            titulo:
              tarea.titulo,

            descripcion:
              tarea.descripcion,

            tiempo_requerido:
              tarea.tiempo_requerido,

            link_url:
              tarea.link_url,

            fecha_realizada:
              datosProgreso.fecha_realizada ||
              null,

            minutos_realizados:
              datosProgreso.minutos_realizados ||
              0,

            veces_realizada:
              datosProgreso.veces_realizada ||
              0

          };

        }
      );


    return Response.json(
      {
        ok: true,

        usuario: {
          fase:
            faseUsuario
        },

        admin:
          usuarioAutenticado.admin === true,

        estadisticas: {

          tareas_realizadas:
            Number(
              estadisticas.tareas_realizadas || 0
            ),

          dias_trabajados:
            Number(
              estadisticas.dias_trabajados || 0
            ),

          minutos_acumulados:
            Number(
              estadisticas.minutos_acumulados || 0
            )

        },

        tareas:
          tareasParaCliente

      },
      {
        status: 200
      }
    );


  } catch (error) {

    return Response.json(
      {
        ok: false,
        error: "No se pudieron cargar los datos."
      },
      {
        status: 500
      }
    );

  }

          }
