/* ============================================================================
   VisitaFlow - Nucleo de la interfaz

   Aplicacion de una sola pagina, sin frameworks y sin paso de compilacion: el
   navegador carga estos archivos tal cual. Es a proposito: el sistema tiene que
   poder instalarse en un equipo sin Internet y sin herramientas de desarrollo.

   Piezas:
     VF.estado   -> la sesion, la marca y la licencia
     VF.api      -> todas las llamadas al servidor en un solo sitio
     VF.icono    -> los iconos en SVG, incrustados
     VF.ui       -> helpers para pintar (avisos, dialogos, estados vacios)
     VF.registrarRuta / VF.ir -> el router por hash
   ============================================================================ */

window.VF = window.VF || {};

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */

VF.estado = {
  usuario: null,
  permisos: [],
  marca: null,
  licencia: null,
  sesionLista: false,
  // Cache breve de catalogos: se pide una vez y se reusa mientras dure la vista.
  catalogos: null,
};

VF.tiene = function (permiso) {
  if (!VF.estado.usuario) return false;
  if (VF.estado.usuario.rol === 'admin') return true;
  return (VF.estado.permisos || []).indexOf(permiso) !== -1;
};

VF.tieneAlguno = function (lista) {
  return (lista || []).some((p) => VF.tiene(p));
};

/* ------------------------------------------------------------------ */
/* Cliente de API                                                      */
/* ------------------------------------------------------------------ */

VF.api = (function () {
  let token = null;

  // El token se guarda en sessionStorage: sobrevive a recargar la pagina pero
  // no queda en el equipo despues de cerrar el navegador. La cookie HttpOnly
  // que pone el servidor sirve de respaldo para descargas.
  function guardarToken(t) {
    token = t;
    try {
      if (t) sessionStorage.setItem('vf_token', t);
      else sessionStorage.removeItem('vf_token');
    } catch (e) {
      /* modo privado: se sigue con el token en memoria */
    }
  }

  function cargarToken() {
    if (token) return token;
    try {
      token = sessionStorage.getItem('vf_token');
    } catch (e) {
      token = null;
    }
    return token;
  }

  class ErrorApi extends Error {
    constructor(mensaje, estado, datos) {
      super(mensaje);
      this.estado = estado;
      this.datos = datos || {};
    }
  }

  async function pedir(metodo, ruta, cuerpo, opciones) {
    const o = opciones || {};
    const cabeceras = {};
    const t = cargarToken();
    if (t) cabeceras.Authorization = 'Bearer ' + t;
    if (cuerpo !== undefined && !(cuerpo instanceof FormData)) cabeceras['Content-Type'] = 'application/json';

    let respuesta;
    try {
      respuesta = await fetch(ruta, {
        method: metodo,
        headers: cabeceras,
        credentials: 'same-origin',
        body: cuerpo === undefined ? undefined : cuerpo instanceof FormData ? cuerpo : JSON.stringify(cuerpo),
      });
    } catch (e) {
      throw new ErrorApi('No hay conexión con el servidor. Revise que el sistema esté en marcha.', 0, {});
    }

    if (respuesta.status === 204) return {};

    let datos = null;
    const tipo = respuesta.headers.get('content-type') || '';
    if (tipo.indexOf('application/json') !== -1) {
      try {
        datos = await respuesta.json();
      } catch (e) {
        datos = null;
      }
    } else {
      datos = { texto: await respuesta.text() };
    }

    if (!respuesta.ok) {
      const mensaje = (datos && datos.mensaje) || 'Ocurrió un error (' + respuesta.status + ').';

      // Sesión vencida: se cierra y se manda al acceso, salvo que ya estemos ahí.
      if (respuesta.status === 401 && o.sinRedirigir !== true) {
        guardarToken(null);
        VF.estado.usuario = null;
        if (VF.rutaActual() !== 'acceso') VF.ir('acceso');
      }
      throw new ErrorApi(mensaje, respuesta.status, datos || {});
    }

    return datos || {};
  }

  return {
    ErrorApi,
    guardarToken,
    cargarToken,
    get: (ruta, opciones) => pedir('GET', ruta, undefined, opciones),
    post: (ruta, cuerpo, opciones) => pedir('POST', ruta, cuerpo === undefined ? {} : cuerpo, opciones),
    patch: (ruta, cuerpo, opciones) => pedir('PATCH', ruta, cuerpo === undefined ? {} : cuerpo, opciones),
    put: (ruta, cuerpo, opciones) => pedir('PUT', ruta, cuerpo === undefined ? {} : cuerpo, opciones),
    borrar: (ruta, cuerpo, opciones) => pedir('DELETE', ruta, cuerpo === undefined ? {} : cuerpo, opciones),

    /** Construye una cadena de consulta omitiendo los valores vacios. */
    consulta: function (parametros) {
      const partes = [];
      Object.keys(parametros || {}).forEach((k) => {
        const v = parametros[k];
        if (v === undefined || v === null || v === '') return;
        partes.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      });
      return partes.length ? '?' + partes.join('&') : '';
    },
  };
})();

/* ------------------------------------------------------------------ */
/* Iconos                                                              */
/* ------------------------------------------------------------------ */

VF.icono = (function () {
  // Trazos de 24x24, estilo de linea. Se incrustan para no depender de una
  // fuente de iconos ni de peticiones externas.
  const trazos = {
    panel: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    registro: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
    personas: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    bitacora: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    anuncio: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    escudo: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    gafete: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5 17c0-1.7 1.3-3 3-3s3 1.3 3 3M14 10h5M14 14h3"/>',
    grafico: '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
    ajustes: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    paleta: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1-.3-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-4.9-4.5-9-10-9z"/>',
    usuarios: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
    llave: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    buscar: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
    imprimir: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
    salida: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    entrada: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
    cerrar: '<path d="M18 6L6 18M6 6l12 12"/>',
    mas: '<path d="M12 5v14M5 12h14"/>',
    ok: '<path d="M20 6L9 17l-5-5"/>',
    alerta: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    reloj: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    descargar: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
    editar: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    basura: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    filtro: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
    carpeta: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    camara: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    telefono: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    edificio: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M9 6h.01M15 6h.01M9 10h.01M15 10h.01M9 14h.01M15 14h.01"/>',
    chevron: '<path d="M9 18l6-6-6-6"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  };

  /**
   * Devuelve el SVG del icono, listo para insertar.
   *
   * El tamaño por defecto es 1em, y va SIEMPRE. Sin esto, un icono puesto en un
   * contenedor ancho se estira hasta llenarlo: paso con la campana de los avisos,
   * que salio del tamaño de media pantalla. Un SVG sin width ni height ocupa
   * todo lo que le dejen.
   *
   * Se puede cambiar con la opcion "tamano"; los que se ajustan por CSS siguen
   * funcionando porque el CSS del contenedor gana.
   */
  function svg(nombre, opciones) {
    const o = opciones || {};
    const trazo = trazos[nombre] || trazos.info;
    const clase = o.clase ? ' class="' + o.clase + '"' : '';
    const tamano = o.tamano
      ? ' width="' + o.tamano + '" height="' + o.tamano + '"'
      : ' width="1em" height="1em"';
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="' + (o.grosor || 1.8) + '" stroke-linecap="round" stroke-linejoin="round"' +
      clase + tamano + ' aria-hidden="true">' + trazo + '</svg>'
    );
  }

  function existe(nombre) {
    return Boolean(trazos[nombre]);
  }

  return { svg, existe, nombres: Object.keys(trazos) };
})();

/* ------------------------------------------------------------------ */
/* Utilidades de interfaz                                              */
/* ------------------------------------------------------------------ */

VF.ui = (function () {
  /** Escapa texto para insertarlo en HTML sin romper la pagina. */
  function esc(valor) {
    if (valor === null || valor === undefined) return '';
    return String(valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Atajo para crear elementos. */
  function el(etiqueta, atributos, hijos) {
    const nodo = document.createElement(etiqueta);
    Object.keys(atributos || {}).forEach((k) => {
      const v = atributos[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'clase') nodo.className = v;
      else if (k === 'texto') nodo.textContent = v;
      else if (k === 'html') nodo.innerHTML = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') nodo.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'datos') Object.keys(v).forEach((d) => nodo.dataset[d] = v[d]);
      else nodo.setAttribute(k, v === true ? '' : v);
    });
    (Array.isArray(hijos) ? hijos : hijos ? [hijos] : []).forEach((h) => {
      if (h === null || h === undefined || h === false) return;
      nodo.appendChild(typeof h === 'string' ? document.createTextNode(h) : h);
    });
    return nodo;
  }

  /** Aviso flotante. Se va solo, pero se puede cerrar. */
  function aviso(tipo, titulo, texto, duracionMs) {
    let contenedor = document.querySelector('.avisos-flotantes');
    if (!contenedor) {
      contenedor = el('div', { clase: 'avisos-flotantes', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(contenedor);
    }
    const iconos = { exito: 'ok', peligro: 'alerta', aviso: 'alerta', info: 'info' };
    const nodo = el('div', { clase: 'flotante flotante--' + (tipo || 'info') }, [
      el('div', { html: VF.icono.svg(iconos[tipo] || 'info'), style: 'flex-shrink:0' }),
      el('div', { clase: 'crecer' }, [
        titulo ? el('strong', { texto: titulo }) : null,
        texto ? el('div', { texto: texto }) : null,
      ]),
      el('button', { clase: 'flotante__cerrar', 'aria-label': 'Cerrar aviso', texto: '×', onClick: () => nodo.remove() }),
    ]);
    contenedor.appendChild(nodo);
    const ms = duracionMs === undefined ? (tipo === 'peligro' ? 9000 : 5000) : duracionMs;
    if (ms > 0) setTimeout(() => nodo.remove(), ms);
    return nodo;
  }

  /** Estado vacio con explicacion y accion sugerida. */
  function vacio(opciones) {
    const o = opciones || {};
    return (
      '<div class="vacio">' +
      '<div class="vacio__icono">' + VF.icono.svg(o.icono || 'carpeta') + '</div>' +
      '<h3>' + esc(o.titulo || 'No hay nada aquí todavía') + '</h3>' +
      (o.texto ? '<p>' + esc(o.texto) + '</p>' : '') +
      (o.accion ? '<button class="boton" data-accion="' + esc(o.accion.clave) + '">' + esc(o.accion.texto) + '</button>' : '') +
      '</div>'
    );
  }

  /** Esqueleto de carga con la forma del contenido que va a llegar. */
  function cargando(filas) {
    let html = '<div class="cargando"><div class="girador"></div><span>Cargando…</span></div>';
    if (filas) {
      html = '<div style="padding:1rem">';
      for (let i = 0; i < filas; i++) html += '<div class="esqueleto" style="width:' + (60 + ((i * 13) % 35)) + '%"></div>';
      html += '</div>';
    }
    return html;
  }

  /** Etiqueta de estado de una visita. */
  function estadoVisita(estado, requiereAprobacion, aprobada) {
    if (estado === 'dentro') {
      if (requiereAprobacion && !aprobada) return '<span class="etiqueta etiqueta--pendiente etiqueta--punto">Sin aprobar</span>';
      return '<span class="etiqueta etiqueta--dentro etiqueta--punto">Dentro</span>';
    }
    if (estado === 'salida') return '<span class="etiqueta etiqueta--punto">Salió</span>';
    if (estado === 'denegada') return '<span class="etiqueta etiqueta--peligro">Denegada</span>';
    if (estado === 'anulada') return '<span class="etiqueta etiqueta--peligro">Anulada</span>';
    if (estado === 'anunciada') return '<span class="etiqueta etiqueta--info">Anunciada</span>';
    return '<span class="etiqueta">' + esc(estado) + '</span>';
  }

  /** Dialogo modal con contenido propio. Devuelve el elemento <dialog>. */
  function dialogo(titulo, cuerpoHtml, opciones) {
    const o = opciones || {};
    const dlg = el('dialog', { clase: 'dialogo' });
    dlg.innerHTML =
      '<div class="dialogo__cabecera">' +
      '<h2>' + esc(titulo) + '</h2>' +
      '<button class="boton boton--fantasma boton--chico" data-cerrar aria-label="Cerrar">' + VF.icono.svg('cerrar') + '</button>' +
      '</div>' +
      '<div class="dialogo__cuerpo">' + cuerpoHtml + '</div>' +
      (o.pie === false ? '' : '<div class="dialogo__pie">' + (o.pie || '<button class="boton boton--secundario" data-cerrar>Cerrar</button>') + '</div>');

    dlg.querySelectorAll('[data-cerrar]').forEach((b) => b.addEventListener('click', () => dlg.close()));
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    return dlg;
  }

  /** Confirmacion. Devuelve una promesa que resuelve true o false. */
  function confirmar(titulo, texto, opciones) {
    const o = opciones || {};
    return new Promise((resolve) => {
      const dlg = dialogo(
        titulo,
        '<p>' + esc(texto) + '</p>' + (o.extraHtml || ''),
        {
          pie:
            '<button class="boton boton--secundario" data-no>' + esc(o.textoCancelar || 'Cancelar') + '</button>' +
            '<button class="boton ' + (o.peligro ? 'boton--peligro' : '') + '" data-si>' + esc(o.textoSi || 'Confirmar') + '</button>',
        }
      );
      let respondido = false;
      dlg.querySelector('[data-si]').addEventListener('click', () => {
        respondido = true;
        dlg.close();
        resolve(true);
      });
      dlg.querySelector('[data-no]').addEventListener('click', () => {
        respondido = true;
        dlg.close();
        resolve(false);
      });
      dlg.addEventListener('close', () => {
        if (!respondido) resolve(false);
      });
    });
  }

  /** Pregunta un dato de texto. Devuelve el texto o null. */
  function preguntar(titulo, etiqueta, opciones) {
    const o = opciones || {};
    return new Promise((resolve) => {
      const id = 'pregunta-' + Date.now();
      const dlg = dialogo(
        titulo,
        '<div class="campo"><label class="campo__etiqueta" for="' + id + '">' + esc(etiqueta) + '</label>' +
          (o.area
            ? '<textarea class="area" id="' + id + '" placeholder="' + esc(o.placeholder || '') + '">' + esc(o.valor || '') + '</textarea>'
            : '<input class="entrada" id="' + id + '" value="' + esc(o.valor || '') + '" placeholder="' + esc(o.placeholder || '') + '">') +
          (o.ayuda ? '<div class="campo__ayuda">' + esc(o.ayuda) + '</div>' : '') +
          '</div>',
        {
          pie:
            '<button class="boton boton--secundario" data-no>Cancelar</button>' +
            '<button class="boton ' + (o.peligro ? 'boton--peligro' : '') + '" data-si>' + esc(o.textoSi || 'Aceptar') + '</button>',
        }
      );
      const campo = dlg.querySelector('#' + id);
      setTimeout(() => campo.focus(), 50);
      let respondido = false;
      const aceptar = () => {
        respondido = true;
        const v = campo.value.trim();
        dlg.close();
        resolve(v || null);
      };
      dlg.querySelector('[data-si]').addEventListener('click', aceptar);
      dlg.querySelector('[data-no]').addEventListener('click', () => {
        respondido = true;
        dlg.close();
        resolve(null);
      });
      campo.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !o.area) aceptar();
      });
      dlg.addEventListener('close', () => {
        if (!respondido) resolve(null);
      });
    });
  }

  /** Fecha y hora legible a partir de un valor del servidor. */
  function fecha(valor, conHora) {
    if (!valor) return '—';
    const d = new Date(valor);
    if (isNaN(d.getTime())) return '—';
    const f = d.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' });
    if (!conHora) return f;
    return f + ' ' + d.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
  }

  /** Solo la hora. */
  function hora(valor) {
    if (!valor) return '—';
    const d = new Date(valor);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
  }

  /** Fecha en formato YYYY-MM-DD para inputs type=date. */
  function fechaEntrada(valor) {
    if (!valor) return '';
    const d = new Date(valor);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  /** Suma dias a hoy y devuelve YYYY-MM-DD. */
  function hoyMenos(dias) {
    const d = new Date();
    d.setDate(d.getDate() - (dias || 0));
    return d.toISOString().slice(0, 10);
  }

  /** Iniciales de un nombre, para los avatares. */
  function iniciales(nombre) {
    const partes = String(nombre || '?').trim().split(/\s+/).slice(0, 2);
    return partes.map((p) => p.charAt(0).toUpperCase()).join('') || '?';
  }

  /** Cuenta regresiva de segundos para acciones que se pueden deshacer. */
  function hace(fechaISO) {
    if (!fechaISO) return '';
    const ms = Date.now() - new Date(fechaISO).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return 'hace ' + min + ' min';
    const h = Math.floor(min / 60);
    if (h < 24) return 'hace ' + h + ' h';
    const d = Math.floor(h / 24);
    return 'hace ' + d + ' día' + (d === 1 ? '' : 's');
  }

  /** Retrasa una funcion hasta que el usuario deja de escribir. */
  function rebote(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms || 300);
    };
  }

  return {
    esc, el, aviso, vacio, cargando, estadoVisita, dialogo, confirmar, preguntar,
    fecha, hora, fechaEntrada, hoyMenos, iniciales, hace, rebote,
  };
})();

/* ------------------------------------------------------------------ */
/* Router por hash                                                     */
/* ------------------------------------------------------------------ */

(function () {
  const rutas = {};
  let actual = null;
  let contenedor = null;

  function registrar(nombre, definicion) {
    rutas[nombre] = definicion;
  }

  function rutaActual() {
    const h = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return h || 'panel';
  }

  function parametros() {
    const h = location.hash || '';
    const i = h.indexOf('?');
    const p = {};
    if (i < 0) return p;
    h.slice(i + 1).split('&').forEach((par) => {
      if (!par) return;
      const [k, v] = par.split('=');
      p[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    return p;
  }

  async function pintar() {
    const nombre = rutaActual();
    const def = rutas[nombre];

    if (!contenedor) contenedor = document.getElementById('vista');

    // Al cambiar de vista se limpian los temporizadores que dejo la anterior.
    if (actual && actual.limpiar && typeof actual.limpiar === 'function') {
      try { actual.limpiar(); } catch (e) { /* la vista ya no existe */ }
    }

    if (!def) {
      contenedor.innerHTML = VF.ui.vacio({
        titulo: 'Esa pantalla no existe',
        texto: 'La dirección a la que llegó no corresponde a ninguna parte del sistema.',
        icono: 'alerta',
      });
      return;
    }

    // Permiso: si la ruta pide uno y no lo tiene, se avisa sin sacarlo del sistema.
    if (def.permiso && !VF.tiene(def.permiso)) {
      contenedor.innerHTML = VF.ui.vacio({
        titulo: 'Sin permiso',
        texto: 'Su usuario no tiene acceso a esta parte del sistema. Si la necesita, pídala al administrador.',
        icono: 'escudo',
      });
      VF.barra.marcar(nombre);
      return;
    }

    actual = def;
    VF.barra.marcar(nombre);
    document.title = (def.titulo || 'VisitaFlow') + ' — ' + ((VF.estado.marca && VF.estado.marca.nombre_comercial) || 'VisitaFlow');

    contenedor.innerHTML = VF.ui.cargando(4);
    try {
      await def.pintar(contenedor, parametros());
    } catch (e) {
      contenedor.innerHTML =
        '<div class="aviso aviso--peligro">' + VF.icono.svg('alerta') +
        '<div><strong>No se pudo cargar la pantalla</strong><div>' + VF.ui.esc(e.message) + '</div>' +
        '<button class="boton boton--secundario boton--chico mt-1" onclick="location.reload()">Reintentar</button></div></div>';
    }
  }

  function ir(destino, params) {
    const q = params ? VF.api.consulta(params) : '';
    const nuevo = '#/' + destino + q;
    if (location.hash === nuevo) pintar();
    else location.hash = nuevo;
  }

  window.addEventListener('hashchange', pintar);

  VF.registrarRuta = registrar;
  VF.ir = ir;
  VF.rutaActual = rutaActual;
  VF.parametros = parametros;
  VF.repintar = pintar;
  VF.establecerContenedor = (n) => { contenedor = n; };
})();

/* ------------------------------------------------------------------ */
/* Barra lateral                                                       */
/* ------------------------------------------------------------------ */

VF.barra = (function () {
  const enlaces = [
    { grupo: 'Recepción' },
    { ruta: 'panel', titulo: 'Panel', icono: 'panel', permiso: 'recepcion.ver' },
    { ruta: 'registro', titulo: 'Registrar visita', icono: 'registro', permiso: 'registro.crear' },
    { ruta: 'dentro', titulo: 'Visitantes dentro', icono: 'personas', permiso: 'recepcion.ver', insignia: 'dentro' },
    { ruta: 'bitacora', titulo: 'Bitácora', icono: 'bitacora', permiso: 'recepcion.ver' },

    { grupo: 'Antes de llegar' },
    { ruta: 'preregistros', titulo: 'Visitas anunciadas', icono: 'anuncio', permiso: 'preregistro.ver', insignia: 'preregistros' },

    { grupo: 'Control' },
    { ruta: 'vigilancia', titulo: 'Lista de vigilancia', icono: 'escudo', permiso: 'vigilancia.ver', insignia: 'bloqueados' },
    { ruta: 'reportes', titulo: 'Reportes', icono: 'grafico', permiso: 'reportes.ver' },

    { grupo: 'Institución' },
    { ruta: 'gafetes', titulo: 'Gafetes', icono: 'gafete', permiso: 'gafete.imprimir' },
    { ruta: 'configuracion', titulo: 'Configuración', icono: 'ajustes', permiso: 'config.ver' },
    { ruta: 'personalizacion', titulo: 'Personalización', icono: 'paleta', permiso: 'config.ver' },
    { ruta: 'usuarios', titulo: 'Usuarios y permisos', icono: 'usuarios', permiso: 'usuarios.ver' },
    { ruta: 'licencia', titulo: 'Licencia', icono: 'llave', permiso: 'licencia.ver' },
  ];

  let insignias = { dentro: 0, preregistros: 0, bloqueados: 0 };

  function pintar() {
    const barra = document.getElementById('barra');
    if (!barra) return;

    const marca = VF.estado.marca || {};
    const nombre = marca.nombre_comercial || marca.nombre || 'Institución';
    const ini = VF.ui.iniciales(nombre);

    let html =
      '<div class="barra__marca">' +
      '<div class="barra__logo">' +
      (marca.logo_url ? '<img src="' + VF.ui.esc(marca.logo_url) + '" alt="">' : VF.ui.esc(ini)) +
      '</div><div class="crecer"><div class="barra__nombre">' + VF.ui.esc(nombre) + '</div>' +
      '<div class="barra__producto">VisitaFlow</div></div></div>' +
      '<nav class="barra__nav" aria-label="Módulos del sistema">';

    enlaces.forEach((e) => {
      if (e.grupo) {
        html += '<div class="barra__grupo">' + VF.ui.esc(e.grupo) + '</div>';
        return;
      }
      if (e.permiso && !VF.tiene(e.permiso)) return;
      html +=
        '<a class="barra__enlace" href="#/' + e.ruta + '" data-ruta="' + e.ruta + '">' +
        VF.icono.svg(e.icono) + '<span>' + VF.ui.esc(e.titulo) + '</span>' +
        (e.insignia ? '<span class="barra__insignia" data-insignia="' + e.insignia + '">0</span>' : '') +
        '</a>';
    });

    html += '</nav><div class="barra__pie">';
    if (VF.estado.usuario) {
      html +=
        '<span class="barra__usuario">' + VF.ui.esc(VF.estado.usuario.nombre) + '</span>' +
        VF.ui.esc(VF.estado.usuario.rol === 'admin' ? 'Administrador' : VF.estado.usuario.rol === 'supervisor' ? 'Supervisor' : 'Recepción') +
        '<button class="barra__salir" id="salir">Cerrar sesión</button>';
    }
    html += '</div>';

    barra.innerHTML = html;

    const salir = document.getElementById('salir');
    if (salir) {
      salir.addEventListener('click', async () => {
        try { await VF.api.post('/api/acceso/salir'); } catch (e) { /* da igual */ }
        VF.api.guardarToken(null);
        VF.estado.usuario = null;
        location.hash = '#/acceso';
        location.reload();
      });
    }

    actualizarInsignias();
  }

  function marcar(ruta) {
    document.querySelectorAll('.barra__enlace').forEach((a) => {
      if (a.dataset.ruta === ruta) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function actualizarInsignias() {
    document.querySelectorAll('[data-insignia]').forEach((n) => {
      const clave = n.dataset.insignia;
      const valor = insignias[clave] || 0;
      n.textContent = valor > 99 ? '99+' : String(valor);
      n.classList.toggle('barra__insignia--alerta', clave === 'bloqueados' && valor > 0);
      n.hidden = valor === 0;
    });
  }

  function establecerInsignias(datos) {
    insignias = Object.assign(insignias, datos || {});
    actualizarInsignias();
  }

  /** Refresca las insignias con el resumen del panel. */
  async function refrescarInsignias() {
    if (!VF.tiene('recepcion.ver')) return;
    try {
      const r = await VF.api.get('/api/panel');
      const m = r.panel.metricas;
      establecerInsignias({
        dentro: m.dentro,
        preregistros: m.preregistros,
        bloqueados: m.bloqueados,
      });
    } catch (e) {
      /* si falla, se dejan las insignias como estaban */
    }
  }

  return { pintar, marcar, establecerInsignias, refrescarInsignias, enlaces };
})();

/* ------------------------------------------------------------------ */
/* Marca de la institucion aplicada como variables CSS                 */
/* ------------------------------------------------------------------ */

VF.aplicarMarca = function (marca) {
  if (!marca) return;
  VF.estado.marca = marca;
  const c = marca.colores || {};
  const raiz = document.documentElement.style;

  const poner = (nombre, valor) => { if (valor) raiz.setProperty(nombre, valor); };
  poner('--marca', c.primario);
  poner('--marca-oscura', c.barra_lateral_oscura || c.primario_oscuro);
  poner('--marca-clara', c.primario_claro);
  poner('--marca-acento', c.acento);
  poner('--marca-secundaria', c.secundario);
  poner('--texto-sobre-marca', c.texto_sobre_primario);

  // El titulo de la pestaña y el favicon siguen a la institucion.
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon && marca.logo_url) favicon.href = marca.logo_url;
};

/* ------------------------------------------------------------------ */
/* Cabecera                                                            */
/* ------------------------------------------------------------------ */

VF.cabecera = function (titulo, subtitulo, accionesHtml) {
  const c = document.getElementById('cabecera');
  if (!c) return;
  c.innerHTML =
    '<div class="cabecera__titulo"><h1>' + VF.ui.esc(titulo) + '</h1>' +
    (subtitulo ? '<div class="cabecera__sub">' + VF.ui.esc(subtitulo) + '</div>' : '') +
    '</div>' +
    '<div class="cabecera__acciones">' + (accionesHtml || '') + '</div>';
};

/* Franja de aviso por licencia. Se pinta arriba, no como modal que estorbe. */
VF.pintarAvisoLicencia = function () {
  const cont = document.getElementById('aviso-licencia');
  if (!cont) return;
  const l = VF.estado.licencia;
  if (!l) { cont.innerHTML = ''; cont.hidden = true; return; }

  const vencida = l.estado === 'vencida' || l.estado === 'invalida' || l.estado === 'sin_licencia';
  const enGracia = l.estado === 'gracia';
  const porVencer = l.estado === 'por_vencer';

  if (!vencida && !enGracia && !porVencer) { cont.innerHTML = ''; cont.hidden = true; return; }

  cont.hidden = false;
  cont.className = 'aviso-licencia' + (vencida ? ' aviso-licencia--peligro' : '');
  const texto = vencida
    ? 'La licencia no permite registrar información nueva. Sus datos siguen consultables y exportables.'
    : enGracia
    ? 'La licencia venció y está en periodo de gracia. Renuévela para no interrumpir el servicio.'
    : 'La licencia vence en ' + l.dias_restantes + ' día(s).';
  cont.innerHTML =
    VF.icono.svg(vencida ? 'alerta' : 'info') +
    '<div class="crecer">' + VF.ui.esc(texto) + (l.licencia ? ' <strong>' + VF.ui.esc(l.licencia.cliente) + '</strong>' : '') + '</div>' +
    (VF.tiene('licencia.ver') ? '<a class="boton boton--secundario boton--chico" href="#/licencia">Ver licencia</a>' : '');
};

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

VF.arrancar = async function () {
  const cont = document.getElementById('vista');
  VF.establecerContenedor(cont);

  // 1. Se intenta recuperar la sesion con el token guardado.
  try {
    const sesion = await VF.api.get('/api/acceso/sesion', { sinRedirigir: true });
    VF.estado.usuario = sesion.usuario;
    VF.estado.permisos = sesion.permisos || [];
    VF.estado.licencia = sesion.licencia;
    VF.aplicarMarca(sesion.marca);
    VF.estado.sesionLista = true;
  } catch (e) {
    VF.estado.sesionLista = false;
  }

  // 2. Sin sesion: se muestra la pantalla de acceso, sin llegar a montar el
  //    armazon de la aplicacion. Montarlo y desmontarlo se veia como un salto.
  if (!VF.estado.usuario) {
    VF.mostrarAcceso();
    return;
  }

  document.getElementById('acceso').hidden = true;
  document.getElementById('app').hidden = false;
  VF.barra.pintar();
  VF.pintarAvisoLicencia();
  VF.barra.refrescarInsignias();
  // Las insignias se refrescan solas cada minuto: recepcion no deberia tener
  // que recargar la pagina para ver que alguien mas acaba de entrar.
  setInterval(() => VF.barra.refrescarInsignias(), 60000);

  VF.repintar();
};

/** Muestra la pantalla de acceso y esconde la aplicacion. */
VF.mostrarAcceso = function () {
  const acceso = document.getElementById('acceso');
  const app = document.getElementById('app');
  if (app) app.hidden = true;
  if (acceso) {
    acceso.hidden = false;
    VF.paginas.acceso(acceso);
  }
};
