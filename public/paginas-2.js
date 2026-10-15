/* ============================================================================
   VisitaFlow - Pantallas de recepcion, bitacora y visitas anunciadas
   ============================================================================ */

VF.paginas = VF.paginas || {};

/** Cabecera con un buscador que filtra al escribir. */
function barraFiltros(cont, opciones) {
  const o = opciones || {};
  return (
    '<div class="tarjeta mb-2"><div class="tarjeta__cuerpo" style="padding:0.8rem 1rem">' +
    '<div class="fila fila--envuelve">' +
    (o.buscador === false ? '' :
      '<div class="buscador">' + VF.icono.svg('buscar') +
      '<input class="entrada" id="f-texto" placeholder="' + VF.ui.esc(o.placeholder || 'Buscar…') + '" value="' + VF.ui.esc(o.texto || '') + '">' +
      '</div>') +
    (o.controles || '') +
    '</div>' +
    '<div class="fila fila--envuelve mt-1" id="f-extra">' + (o.extra || '') + '</div>' +
    '</div></div>'
  );
}

/** Paginador simple. */
function paginador(listado, irA) {
  if (!listado.paginas || listado.paginas <= 1) return '';
  const p = listado.pagina;
  const total = listado.paginas;
  return (
    '<div class="fila fila--separada mt-2">' +
    '<div class="texto-chico texto-suave">' + listado.total + ' registro(s) · página ' + p + ' de ' + total + '</div>' +
    '<div class="fila">' +
    '<button class="boton boton--secundario boton--chico" data-pagina="' + (p - 1) + '"' + (p <= 1 ? ' disabled' : '') + '>Anterior</button>' +
    '<button class="boton boton--secundario boton--chico" data-pagina="' + (p + 1) + '"' + (p >= total ? ' disabled' : '') + '>Siguiente</button>' +
    '</div></div>'
  );
}

function conectarPaginador(cont, alCambiar) {
  cont.querySelectorAll('[data-pagina]').forEach((b) => {
    b.addEventListener('click', () => alCambiar(Number(b.dataset.pagina)));
  });
}

/* ============================================================================
   VISITANTES DENTRO
   ============================================================================ */

VF.registrarRuta('dentro', {
  titulo: 'Visitantes dentro',
  permiso: 'recepcion.ver',
  async pintar(cont, params) {
    let pagina = 1;
    let filtros = {
      estado: 'dentro',
      texto: params.texto || '',
      largas: params.largas === '1' ? '1' : '',
      sin_aprobar: params.sin_aprobar === '1' ? '1' : '',
      orden: 'recientes',
    };

    VF.cabecera('Visitantes dentro', 'Quiénes están ahora en las instalaciones');

    async function cargar() {
      cont.innerHTML = VF.ui.cargando();
      const r = await VF.api.get('/api/visitas' + VF.api.consulta(Object.assign({}, filtros, { pagina, tamano: 25 })));
      const l = r.listado;

      VF.barra.establecerInsignias({ dentro: filtros.estado === 'dentro' && !filtros.texto && !filtros.largas && !filtros.sin_aprobar ? l.total : undefined });

      cont.innerHTML =
        '<div id="avisos-panel"></div>' +
        barraFiltros(cont, {
          texto: filtros.texto,
          placeholder: 'Nombre, cédula, empresa o código…',
          controles:
            '<select class="selector" id="f-orden" style="max-width:190px">' +
            opcion('recientes', 'Más recientes', filtros.orden) +
            opcion('antiguas', 'Más antiguos', filtros.orden) +
            opcion('nombre', 'Por nombre', filtros.orden) +
            opcion('duracion', 'Más tiempo dentro', filtros.orden) +
            '</select>' +
            '<select class="selector" id="f-estado" style="max-width:180px">' +
            opcion('dentro', 'Solo dentro', filtros.estado) +
            opcion('dentro,anunciada', 'Dentro y anunciadas', filtros.estado) +
            opcion('salida', 'Con salida', filtros.estado) +
            opcion('', 'Todas', filtros.estado) +
            '</select>',
          extra:
            '<label class="campo campo--interruptor mb-0"><input type="checkbox" class="interruptor" id="f-largas"' +
            (filtros.largas ? ' checked' : '') + '><span class="texto-chico">Solo visitas largas</span></label>' +
            '<label class="campo campo--interruptor mb-0"><input type="checkbox" class="interruptor" id="f-sinaprobar"' +
            (filtros.sin_aprobar ? ' checked' : '') + '><span class="texto-chico">Solo sin aprobar</span></label>' +
            '<span class="crecer"></span>' +
            (VF.tiene('recepcion.anular')
              ? '<button class="boton boton--secundario boton--chico" id="cerrar-vencidas">Cerrar visitas vencidas</button>'
              : ''),
        }) +
        (l.filas.length
          ? '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
            '<th>Visitante</th><th>Destino</th><th>Entrada</th><th>Tiempo</th><th>Estado</th><th></th>' +
            '</tr></thead><tbody>' +
            l.filas.map(fila).join('') +
            '</tbody></table></div></div>' +
            paginador(l, (p) => { pagina = p; cargar(); })
          : VF.ui.vacio({
              titulo: filtros.texto || filtros.largas || filtros.sin_aprobar ? 'Ningún resultado' : 'No hay visitantes dentro',
              texto: filtros.texto || filtros.largas || filtros.sin_aprobar
                ? 'Pruebe con otros filtros.'
                : 'Cuando alguien registre su entrada aparecerá aquí, con el tiempo que lleva dentro.',
              icono: 'personas',
              accion: VF.tiene('registro.crear') ? { clave: 'nueva', texto: 'Registrar una visita' } : null,
            }));

      function fila(v) {
        const larga = v.estado === 'dentro' && v.minutos > 240;
        return (
          '<tr>' +
          '<td><div class="tabla__principal">' + VF.ui.esc(v.nombre || '—') + '</div>' +
          '<div class="tabla__secundario">' + VF.ui.esc(v.cedula_formato || 'sin cédula') +
          (v.empresa ? ' · ' + VF.ui.esc(v.empresa) : '') + '</div></td>' +
          '<td><div>' + VF.ui.esc(v.departamento || '—') + '</div>' +
          '<div class="tabla__secundario">' + VF.ui.esc(v.visitado || '') + '</div></td>' +
          '<td class="texto-chico">' + VF.ui.esc(VF.ui.hora(v.entrada)) + '<div class="tabla__secundario">' + VF.ui.esc(VF.ui.fecha(v.entrada)) + '</div></td>' +
          '<td>' + (larga ? '<span class="etiqueta etiqueta--pendiente">' + VF.ui.esc(v.duracion || '') + '</span>' : VF.ui.esc(v.duracion || '')) + '</td>' +
          '<td>' + VF.ui.estadoVisita(v.estado, v.requiere_aprobacion, v.aprobada) + '</td>' +
          '<td><div class="tabla__acciones">' +
          (v.requiere_aprobacion && !v.aprobada && VF.tiene('recepcion.aprobar')
            ? '<button class="boton boton--chico" data-aprobar="' + v.id + '">Aprobar</button>'
            : '') +
          (v.estado === 'dentro' && VF.tiene('gafete.imprimir')
            ? '<button class="boton boton--secundario boton--chico" data-gafete="' + v.id + '" title="Ver gafete">' + VF.icono.svg('imprimir') + '</button>'
            : '') +
          (v.estado === 'dentro' && VF.tiene('recepcion.salida')
            ? '<button class="boton boton--secundario boton--chico" data-salida="' + v.id + '">Salida</button>'
            : '') +
          '</div></td></tr>'
        );
      }

      function opcion(valor, etiqueta, actual) {
        return '<option value="' + VF.ui.esc(valor) + '"' + (String(actual) === String(valor) ? ' selected' : '') + '>' + VF.ui.esc(etiqueta) + '</option>';
      }

      const buscar = VF.ui.rebote(() => { filtros.texto = document.getElementById('f-texto').value.trim(); pagina = 1; cargar(); }, 350);
      document.getElementById('f-texto').addEventListener('input', buscar);
      document.getElementById('f-orden').addEventListener('change', (e) => { filtros.orden = e.target.value; cargar(); });
      document.getElementById('f-estado').addEventListener('change', (e) => { filtros.estado = e.target.value; pagina = 1; cargar(); });
      document.getElementById('f-largas').addEventListener('change', (e) => { filtros.largas = e.target.checked ? '1' : ''; pagina = 1; cargar(); });
      document.getElementById('f-sinaprobar').addEventListener('change', (e) => { filtros.sin_aprobar = e.target.checked ? '1' : ''; pagina = 1; cargar(); });

      const vencidas = document.getElementById('cerrar-vencidas');
      if (vencidas) {
        vencidas.addEventListener('click', async () => {
          const ok = await VF.ui.confirmar(
            'Cerrar visitas vencidas',
            'Se registrará la salida de las visitas que llevan más de 16 horas abiertas (gente que se fue sin registrar la salida). No se borra nada.',
            { textoSi: 'Cerrar las vencidas' }
          );
          if (!ok) return;
          try {
            const r = await VF.api.post('/api/recepcion/cerrar-vencidas', {});
            VF.ui.aviso('exito', 'Listo', r.cerradas + ' visita(s) cerrada(s) automáticamente.');
            VF.barra.refrescarInsignias();
            cargar();
          } catch (e) {
            VF.ui.aviso('peligro', 'No se pudo cerrar', e.message);
          }
        });
      }

      conectarPaginador(cont, (p) => { pagina = p; cargar(); });
    }

    cont.addEventListener('click', async (ev) => {
      const salida = ev.target.closest('[data-salida]');
      if (salida) return VF.paginas.registrarSalida(salida.dataset.salida, cargar);

      const aprobar = ev.target.closest('[data-aprobar]');
      if (aprobar) {
        const quien = await VF.ui.preguntar('Aprobar visita', '¿Quién autoriza? (opcional)', { textoSi: 'Aprobar' });
        try {
          await VF.api.post('/api/visitas/' + aprobar.dataset.aprobar + '/aprobar', { aprobada_por: quien || undefined });
          VF.ui.aviso('exito', 'Visita aprobada');
          cargar();
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo aprobar', e.message);
        }
        return;
      }

      const gafete = ev.target.closest('[data-gafete]');
      if (gafete) return VF.paginas.verGafete(gafete.dataset.gafete);

      if (ev.target.closest('[data-accion="nueva"]')) VF.ir('registro');
    });

    await cargar();
    cargarAvisos();
  },
});

/* ============================================================================
   AVISOS AL ANFITRION

   Cuando llega una visita, el sistema avisa a quien la recibe. Este panel los
   muestra en Recepcion, que es donde esta quien puede hacer algo al respecto.

   POR QUE HACE FALTA AUNQUE HAYA CORREO
   -------------------------------------
   El aviso se guarda SIEMPRE en la base, haya o no servidor de correo. Una
   institucion sin correo configurado se quedaria sin avisar de ninguna forma si
   este panel no existiera: el aviso guardado es justo lo que hace que eso no
   pase.
   ============================================================================ */

async function cargarAvisos() {
  const panel = document.getElementById('avisos-panel');
  if (!panel) return;

  let datos;
  try {
    datos = await VF.api.get('/api/avisos?limite=8');
  } catch (e) {
    // Si falla, no se rompe la pantalla: los avisos son un extra.
    panel.innerHTML = '';
    return;
  }

  const lista = datos.avisos || [];
  const sinLeer = datos.sin_leer || 0;

  /* La insignia del menu lateral cuenta los avisos sin leer, igual que la de
     visitantes dentro. Asi se ve desde cualquier pantalla. */
  VF.barra.establecerInsignias({ avisos: sinLeer || undefined });

  if (!lista.length) {
    panel.innerHTML = '';
    return;
  }

  /** Como se muestra el estado del envio. */
  function estadoDe(a) {
    if (a.estado === 'enviado') return '<span class="etiqueta etiqueta--info">Correo enviado</span>';
    if (a.estado === 'sin_correo') return '<span class="etiqueta">Sin correo configurado</span>';
    if (a.estado === 'error') {
      // Se dice el motivo: es lo unico que permite arreglarlo.
      return '<span class="etiqueta etiqueta--peligro" title="' + VF.ui.esc(a.error || '') + '">No se pudo enviar</span>';
    }
    return '';
  }

  panel.innerHTML =
    '<div class="tarjeta mb-1" style="border-left:4px solid var(--acento)">' +
    '<div class="tarjeta__cabecera">' +
    '<h2 style="font-size:1rem">' + VF.icono.svg('anuncio', { tamano: 18 }) + ' Avisos al anfitrión</h2>' +
    '<span class="etiqueta etiqueta--info">' + sinLeer + ' sin leer</span>' +
    '<span class="crecer"></span>' +
    '<button class="boton boton--secundario boton--chico" id="avisos-todos">Marcar todos como leídos</button>' +
    '</div>' +
    '<div class="tarjeta__cuerpo" style="padding:0">' +
    '<div class="tabla-envoltura"><table class="tabla"><tbody>' +
    lista.map((a) =>
      '<tr>' +
      '<td style="width:34%"><strong>' + VF.ui.esc(a.destinatario) + '</strong>' +
      (a.destinatario_correo ? '<div class="texto-tenue texto-chico">' + VF.ui.esc(a.destinatario_correo) + '</div>' : '') +
      '</td>' +
      '<td>' + VF.ui.esc(a.asunto) +
      '<div class="texto-tenue texto-chico">' +
      (a.visitante ? VF.ui.esc(a.visitante) + ' · ' : '') +
      VF.ui.fecha(a.creado, true) + '</div></td>' +
      '<td style="width:1%">' + estadoDe(a) + '</td>' +
      '<td style="width:1%"><button class="boton boton--secundario boton--chico" data-aviso="' + a.id + '">Leído</button></td>' +
      '</tr>').join('') +
    '</tbody></table></div></div></div>';

  document.getElementById('avisos-todos').addEventListener('click', async () => {
    try {
      await VF.api.post('/api/avisos/leidos', {});
      cargarAvisos();
    } catch (e) {
      VF.ui.aviso('peligro', 'No se pudieron marcar', e.message);
    }
  });

  panel.querySelectorAll('[data-aviso]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await VF.api.post('/api/avisos/' + b.dataset.aviso + '/leido', {});
        cargarAvisos();
      } catch (e) {
        VF.ui.aviso('peligro', 'No se pudo marcar', e.message);
      }
    });
  });
}

/* ============================================================================
   BITACORA
   ============================================================================ */

VF.registrarRuta('bitacora', {
  titulo: 'Bitácora de visitas',
  permiso: 'recepcion.ver',
  async pintar(cont, params) {
    let pagina = 1;
    let filtros = {
      desde: params.desde || VF.ui.hoyMenos(7),
      hasta: params.hasta || VF.ui.hoyMenos(0),
      estado: params.estado || '',
      texto: params.texto || '',
      orden: 'recientes',
    };
    let opcionesCat = null;

    VF.cabecera('Bitácora de visitas', 'Historial completo, con filtros y exportación');

    async function cargar() {
      cont.innerHTML = VF.ui.cargando();
      const [r, op] = await Promise.all([
        VF.api.get('/api/visitas' + VF.api.consulta(Object.assign({}, filtros, { pagina, tamano: 25 }))),
        opcionesCat ? Promise.resolve(null) : VF.api.get('/api/reportes/resumen?desde=' + filtros.desde + '&hasta=' + filtros.hasta),
      ]);
      if (op && op.opciones) opcionesCat = op.opciones;
      const l = r.listado;

      cont.innerHTML =
        barraFiltros(cont, {
          texto: filtros.texto,
          placeholder: 'Nombre, cédula, código, empresa o persona visitada…',
          controles:
            '<input class="entrada" type="date" id="f-desde" value="' + VF.ui.esc(filtros.desde) + '" style="max-width:160px">' +
            '<input class="entrada" type="date" id="f-hasta" value="' + VF.ui.esc(filtros.hasta) + '" style="max-width:160px">' +
            '<select class="selector" id="f-estado" style="max-width:170px">' +
            '<option value="">Todos los estados</option>' +
            (opcionesCat ? opcionesCat.estados.map((e) => '<option value="' + e.valor + '"' + (filtros.estado === e.valor ? ' selected' : '') + '>' + VF.ui.esc(e.etiqueta) + '</option>').join('') : '') +
            '</select>' +
            '<select class="selector" id="f-depto" style="max-width:200px"><option value="">Todos los departamentos</option>' +
            (opcionesCat ? opcionesCat.departamentos.map((d) => '<option value="' + d.id + '"' + (String(filtros.departamento_id) === String(d.id) ? ' selected' : '') + '>' + VF.ui.esc(d.nombre) + '</option>').join('') : '') +
            '</select>',
          extra:
            '<select class="selector" id="f-motivo" style="max-width:200px"><option value="">Todos los motivos</option>' +
            (opcionesCat ? opcionesCat.motivos.map((m) => '<option value="' + m.id + '"' + (String(filtros.motivo_id) === String(m.id) ? ' selected' : '') + '>' + VF.ui.esc(m.nombre) + '</option>').join('') : '') +
            '</select>' +
            '<span class="crecer"></span>' +
            (VF.tiene('reportes.exportar')
              ? '<button class="boton boton--secundario boton--chico" id="exportar">' + VF.icono.svg('descargar') + 'Exportar CSV</button>'
              : ''),
        }) +
        (l.filas.length
          ? '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
            '<th>Visitante</th><th>Destino</th><th>Motivo</th><th>Entrada</th><th>Salida</th><th>Duración</th><th>Estado</th><th></th>' +
            '</tr></thead><tbody>' +
            l.filas.map(fila).join('') +
            '</tbody></table></div></div>' +
            paginador(l, (p) => { pagina = p; cargar(); })
          : VF.ui.vacio({
              titulo: 'Ninguna visita en ese rango',
              texto: 'Cambie las fechas o quite los filtros para ver más resultados.',
              icono: 'bitacora',
            }));

      function fila(v) {
        return (
          '<tr>' +
          '<td><div class="tabla__principal">' + VF.ui.esc(v.nombre || '—') + '</div>' +
          '<div class="tabla__secundario">' + VF.ui.esc(v.cedula_formato || 'sin cédula') +
          (v.empresa ? ' · ' + VF.ui.esc(v.empresa) : '') + '</div></td>' +
          '<td><div>' + VF.ui.esc(v.departamento || '—') + '</div>' +
          '<div class="tabla__secundario">' + VF.ui.esc(v.visitado || '') + '</div></td>' +
          '<td class="texto-chico">' + VF.ui.esc(v.motivo || '—') + '</td>' +
          '<td class="texto-chico">' + VF.ui.esc(VF.ui.fecha(v.entrada, true)) + '</td>' +
          '<td class="texto-chico">' + VF.ui.esc(v.salida ? VF.ui.fecha(v.salida, true) : '—') + '</td>' +
          '<td class="texto-chico">' + VF.ui.esc(v.duracion || '—') + '</td>' +
          '<td>' + VF.ui.estadoVisita(v.estado, v.requiere_aprobacion, v.aprobada) + '</td>' +
          '<td><div class="tabla__acciones">' +
          '<button class="boton boton--fantasma boton--chico" data-ver="' + v.id + '" title="Ver detalle">' + VF.icono.svg('buscar') + '</button>' +
          (VF.tiene('gafete.imprimir')
            ? '<button class="boton boton--fantasma boton--chico" data-gafete="' + v.id + '" title="Ver gafete">' + VF.icono.svg('imprimir') + '</button>'
            : '') +
          (v.estado === 'dentro' && VF.tiene('recepcion.salida')
            ? '<button class="boton boton--secundario boton--chico" data-salida="' + v.id + '">Salida</button>'
            : '') +
          '</div></td></tr>'
        );
      }

      const buscar = VF.ui.rebote(() => { filtros.texto = document.getElementById('f-texto').value.trim(); pagina = 1; cargar(); }, 350);
      document.getElementById('f-texto').addEventListener('input', buscar);
      ['desde', 'hasta'].forEach((k) => {
        document.getElementById('f-' + k).addEventListener('change', (e) => { filtros[k] = e.target.value; pagina = 1; cargar(); });
      });
      document.getElementById('f-estado').addEventListener('change', (e) => { filtros.estado = e.target.value; pagina = 1; cargar(); });
      document.getElementById('f-depto').addEventListener('change', (e) => { filtros.departamento_id = e.target.value; pagina = 1; cargar(); });
      document.getElementById('f-motivo').addEventListener('change', (e) => { filtros.motivo_id = e.target.value; pagina = 1; cargar(); });

      const exp = document.getElementById('exportar');
      if (exp) {
        exp.addEventListener('click', () => {
          // La descarga la hace el navegador; la cookie de sesion viaja sola.
          window.location.href = '/api/reportes/visitas.csv' + VF.api.consulta(filtros);
        });
      }

      conectarPaginador(cont, (p) => { pagina = p; cargar(); });
    }

    cont.addEventListener('click', async (ev) => {
      const salida = ev.target.closest('[data-salida]');
      if (salida) return VF.paginas.registrarSalida(salida.dataset.salida, cargar);

      const gafete = ev.target.closest('[data-gafete]');
      if (gafete) return VF.paginas.verGafete(gafete.dataset.gafete);

      const ver = ev.target.closest('[data-ver]');
      if (ver) {
        try {
          const r = await VF.api.get('/api/visitas/' + ver.dataset.ver);
          const v = r.visita;
          const filas = [
            ['Código', v.codigo], ['Cédula', v.cedula_formato || '—'], ['Nombre', v.nombre_completo],
            ['Edad', v.edad !== null ? v.edad + ' años' : '—'], ['Empresa', v.empresa || '—'],
            ['Teléfono', v.telefono || '—'], ['Correo', v.correo || '—'],
            ['Departamento', v.departamento || '—'], ['Motivo', v.motivo || '—'], ['Visita a', v.visitado || '—'],
            ['Acompañantes', v.acompanantes], ['Vehículo', v.vehiculo ? v.vehiculo + (v.placa ? ' (' + v.placa + ')' : '') : '—'],
            ['Pertenencias', v.pertenencias || '—'],
            ['Entrada', VF.ui.fecha(v.entrada, true)], ['Salida', v.salida ? VF.ui.fecha(v.salida, true) : '—'],
            ['Duración', v.duracion || '—'], ['Estado', v.estado],
            ['Requiere aprobación', v.requiere_aprobacion ? (v.aprobada ? 'Sí, aprobada por ' + (v.aprobada_por || '—') : 'Sí, pendiente') : 'No'],
            ['Registró', v.operador || '—'], ['Salió con', v.salida_operador || '—'],
            ['Observaciones', v.observaciones || '—'],
          ];
          VF.ui.dialogo(
            'Visita ' + v.codigo,
            '<dl class="ficha__datos">' + filas.map((f) =>
              '<div class="ficha__dato"><dt>' + VF.ui.esc(f[0]) + '</dt><dd>' + VF.ui.esc(f[1]) + '</dd></div>').join('') + '</dl>',
            {
              pie:
                (VF.tiene('gafete.imprimir') ? '<button class="boton boton--secundario" data-gafete="' + v.id + '">' + VF.icono.svg('imprimir') + 'Ver gafete</button>' : '') +
                (v.estado === 'dentro' && VF.tiene('recepcion.salida') ? '<button class="boton" data-salida="' + v.id + '">Registrar salida</button>' : '') +
                '<button class="boton boton--secundario" data-cerrar>Cerrar</button>',
            }
          );
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo abrir la visita', e.message);
        }
      }
    });

    await cargar();
  },
});

/* ============================================================================
   VISITAS ANUNCIADAS (PRE-REGISTRO)
   ============================================================================ */

VF.registrarRuta('preregistros', {
  titulo: 'Visitas anunciadas',
  permiso: 'preregistro.ver',
  async pintar(cont, params) {
    let pagina = 1;
    let filtros = { estado: params.estado || 'pendiente', texto: params.texto || '' };
    let catalogos = null;

    const subtitulo = 'El anfitrión anuncia la visita; al llegar, el formulario se completa solo';

    async function cargar() {
      cont.innerHTML = VF.ui.cargando();
      const r = await VF.api.get('/api/preregistros' + VF.api.consulta(Object.assign({}, filtros, { pagina, tamano: 25 })));
      catalogos = r.catalogos;
      const l = r.listado;
      const res = r.resumen;

      VF.barra.establecerInsignias({ preregistros: filtros.estado === 'pendiente' && !filtros.texto ? res.pendientes : undefined });

      VF.cabecera(
        'Visitas anunciadas',
        subtitulo,
        VF.tiene('preregistro.crear')
          ? '<button class="boton" id="nuevo">' + VF.icono.svg('mas') + 'Anunciar visita</button>'
          : ''
      );

      cont.innerHTML =
        '<div class="rejilla rejilla--metricas mb-3">' +
        metrica('Pendientes', res.pendientes, 'por llegar', res.pendientes > 0 ? 'info' : '') +
        metrica('Para hoy', res.hoy, 'previstas para hoy') +
        metrica('Ya llegaron', res.usados, 'con check-in hecho') +
        metrica('Vencidas', res.vencidos, 'no llegaron a tiempo') +
        metrica('Canceladas', res.cancelados, 'anuladas por el anfitrión') +
        '</div>' +

        barraFiltros(cont, {
          texto: filtros.texto,
          placeholder: 'Código, nombre, cédula o empresa…',
          controles:
            '<select class="selector" id="f-estado" style="max-width:200px">' +
            ['pendiente', 'usado', 'vencido', 'cancelado', ''].map((e) =>
              '<option value="' + e + '"' + (filtros.estado === e ? ' selected' : '') + '>' +
              (e ? { pendiente: 'Pendientes', usado: 'Ya llegaron', vencido: 'Vencidas', cancelado: 'Canceladas' }[e] : 'Todas') +
              '</option>').join('') +
            '</select>',
        }) +

        (l.filas.length
          ? '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
            '<th>Código</th><th>Visitante</th><th>Destino</th><th>Prevista</th><th>Estado</th><th></th>' +
            '</tr></thead><tbody>' +
            l.filas.map(fila).join('') +
            '</tbody></table></div></div>' +
            paginador(l, (p) => { pagina = p; cargar(); })
          : VF.ui.vacio({
              titulo: 'No hay visitas anunciadas',
              texto: 'Cuando un anfitrión anuncie una visita, aparecerá aquí con su código de confirmación.',
              icono: 'anuncio',
              accion: VF.tiene('preregistro.crear') ? { clave: 'nuevo', texto: 'Anunciar una visita' } : null,
            }));

      function metrica(etiqueta, valor, nota, tipo) {
        return '<div class="metrica ' + (tipo ? 'metrica--' + tipo : '') + '">' +
          '<div class="metrica__etiqueta">' + VF.ui.esc(etiqueta) + '</div>' +
          '<div class="metrica__valor">' + valor + '</div>' +
          '<div class="metrica__nota">' + VF.ui.esc(nota) + '</div></div>';
      }

      function fila(p) {
        const etiquetas = {
          pendiente: '<span class="etiqueta etiqueta--info">Pendiente</span>',
          usado: '<span class="etiqueta etiqueta--dentro">Llegó</span>',
          vencido: '<span class="etiqueta">Vencida</span>',
          cancelado: '<span class="etiqueta etiqueta--peligro">Cancelada</span>',
        };
        return (
          '<tr>' +
          '<td><span class="texto-mono negrita">' + VF.ui.esc(p.codigo) + '</span></td>' +
          '<td><div class="tabla__principal">' + VF.ui.esc(p.nombre) + '</div>' +
          '<div class="tabla__secundario">' + VF.ui.esc(p.cedula_formato || 'sin cédula') +
          (p.empresa ? ' · ' + VF.ui.esc(p.empresa) : '') + '</div></td>' +
          '<td><div>' + VF.ui.esc(p.departamento || '—') + '</div>' +
          '<div class="tabla__secundario">' + VF.ui.esc(p.visitado || '') + '</div></td>' +
          '<td class="texto-chico">' + VF.ui.esc(p.fecha_prevista_legible || '—') + '</td>' +
          '<td>' + etiquetas[p.estado] + '</td>' +
          '<td><div class="tabla__acciones">' +
          (p.estado === 'pendiente' && p.cedula && VF.tiene('registro.crear')
            ? '<button class="boton boton--chico" data-checkin="' + VF.ui.esc(p.cedula) + '">Check-in</button>'
            : '') +
          (p.estado === 'pendiente' && VF.tiene('preregistro.editar')
            ? '<button class="boton boton--fantasma boton--chico" data-editar="' + p.id + '" title="Editar">' + VF.icono.svg('editar') + '</button>' +
              '<button class="boton boton--fantasma boton--chico" data-cancelar="' + p.id + '" title="Cancelar">' + VF.icono.svg('cerrar') + '</button>'
            : '') +
          '<button class="boton boton--fantasma boton--chico" data-copiar="' + VF.ui.esc(p.codigo) + '" title="Copiar código">⧉</button>' +
          '</div></td></tr>'
        );
      }

      const buscar = VF.ui.rebote(() => { filtros.texto = document.getElementById('f-texto').value.trim(); pagina = 1; cargar(); }, 350);
      document.getElementById('f-texto').addEventListener('input', buscar);
      document.getElementById('f-estado').addEventListener('change', (e) => { filtros.estado = e.target.value; pagina = 1; cargar(); });

      const nuevo = document.getElementById('nuevo');
      if (nuevo) nuevo.addEventListener('click', () => formularioAnuncio());

      conectarPaginador(cont, (p) => { pagina = p; cargar(); });
    }

    /** Formulario para anunciar una visita (crear o editar). */
    function formularioAnuncio(actual) {
      const a = actual || {};
      VF.ui.dialogo(
        actual ? 'Editar visita anunciada' : 'Anunciar una visita',
        '<div class="fila-campos">' +
        campo('p-nombre', 'Nombre de quien viene', a.nombre_completo, true) +
        campo('p-cedula', 'Cédula (opcional ahora)', a.cedula_formato, false) +
        '</div>' +
        '<div class="fila-campos">' +
        campo('p-empresa', 'Empresa o procedencia', a.empresa, false) +
        campo('p-telefono', 'Teléfono', a.telefono, false) +
        '</div>' +
        '<div class="fila-campos">' +
        '<div class="campo"><label class="campo__etiqueta" for="p-departamento">Departamento</label>' +
        '<select class="selector" id="p-departamento"><option value="">— Elija —</option>' +
        catalogos.departamentos.map((d) => '<option value="' + d.id + '">' + VF.ui.esc(d.nombre) + '</option>').join('') +
        '</select></div>' +
        '<div class="campo"><label class="campo__etiqueta" for="p-motivo">Motivo</label>' +
        '<select class="selector" id="p-motivo"><option value="">— Elija —</option>' +
        catalogos.motivos.map((m) => '<option value="' + m.id + '">' + VF.ui.esc(m.nombre) + '</option>').join('') +
        '</select></div>' +
        '</div>' +
        '<div class="fila-campos">' +
        campo('p-visitado', '¿A quién visita?', a.visitado, false) +
        '<div class="campo"><label class="campo__etiqueta" for="p-fecha">Fecha y hora prevista</label>' +
        '<input class="entrada" type="datetime-local" id="p-fecha" value="' + VF.ui.esc(a.fecha_prevista ? new Date(a.fecha_prevista).toISOString().slice(0, 16) : '') + '"></div>' +
        '</div>' +
        '<div class="fila-campos">' +
        campo('p-acompanantes', 'Acompañantes', a.acompanantes || 0, false, 'number') +
        campo('p-vehiculo', 'Vehículo', a.vehiculo, false) +
        '</div>' +
        '<div class="campo"><label class="campo__etiqueta" for="p-notas">Notas</label>' +
        '<textarea class="area" id="p-notas">' + VF.ui.esc(a.notas || '') + '</textarea></div>' +
        '<div class="aviso aviso--info">' + VF.icono.svg('info') +
        '<div class="texto-chico">La cédula es opcional al anunciar. Se pedirá al llegar, que es cuando se valida contra la base.</div></div>',
        {
          pie:
            '<button class="boton boton--secundario" data-cerrar>Cancelar</button>' +
            '<button class="boton" id="p-guardar">' + (actual ? 'Guardar cambios' : 'Anunciar') + '</button>',
        }
      );

      if (a.departamento_id) document.getElementById('p-departamento').value = a.departamento_id;
      if (a.motivo_id) document.getElementById('p-motivo').value = a.motivo_id;

      document.getElementById('p-guardar').addEventListener('click', async () => {
        const datos = {
          nombre_completo: document.getElementById('p-nombre').value.trim(),
          cedula: document.getElementById('p-cedula').value.replace(/\D/g, ''),
          empresa: document.getElementById('p-empresa').value.trim(),
          telefono: document.getElementById('p-telefono').value.trim(),
          departamento_id: document.getElementById('p-departamento').value,
          motivo_id: document.getElementById('p-motivo').value,
          visitado: document.getElementById('p-visitado').value.trim(),
          fecha_prevista: document.getElementById('p-fecha').value,
          acompanantes: document.getElementById('p-acompanantes').value,
          vehiculo: document.getElementById('p-vehiculo').value.trim(),
          notas: document.getElementById('p-notas').value.trim(),
        };
        if (!datos.nombre_completo) {
          VF.ui.aviso('aviso', 'Falta el nombre', 'Indique el nombre de quien va a venir.');
          return;
        }
        try {
          if (actual) {
            await VF.api.patch('/api/preregistros/' + actual.id, datos);
            VF.ui.aviso('exito', 'Cambios guardados');
          } else {
            const r = await VF.api.post('/api/preregistros', datos);
            VF.ui.aviso('exito', 'Visita anunciada', 'Código de confirmación: ' + r.codigo + '. Válido por ' + r.vigencia_horas + ' horas.', 12000);
          }
          document.querySelector('.dialogo').close();
          cargar();
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo guardar', e.message);
        }
      });
    }

    function campo(id, etiqueta, valor, obligatorio, tipo) {
      return '<div class="campo"><label class="campo__etiqueta" for="' + id + '">' + VF.ui.esc(etiqueta) +
        (obligatorio ? ' <span class="req">*</span>' : '') + '</label>' +
        '<input class="entrada" id="' + id + '" type="' + (tipo || 'text') + '" value="' + VF.ui.esc(valor || '') + '"></div>';
    }

    cont.addEventListener('click', async (ev) => {
      if (ev.target.closest('[data-accion="nuevo"]') || ev.target.closest('#nuevo')) return formularioAnuncio();

      const copiar = ev.target.closest('[data-copiar]');
      if (copiar) {
        try {
          await navigator.clipboard.writeText(copiar.dataset.copiar);
          VF.ui.aviso('exito', 'Código copiado', copiar.dataset.copiar);
        } catch (e) {
          VF.ui.aviso('info', 'Código', copiar.dataset.copiar);
        }
        return;
      }

      const checkin = ev.target.closest('[data-checkin]');
      if (checkin) {
        location.hash = '#/registro?cedula=' + encodeURIComponent(checkin.dataset.checkin);
        return;
      }

      const editar = ev.target.closest('[data-editar]');
      if (editar) {
        try {
          const lista = await VF.api.get('/api/preregistros?tamano=200&estado=pendiente');
          const p = lista.listado.filas.find((x) => String(x.id) === String(editar.dataset.editar));
          if (p) formularioAnuncio(Object.assign({}, p, { departamento_id: p.departamento ? null : null }));
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo abrir', e.message);
        }
        return;
      }

      const cancelar = ev.target.closest('[data-cancelar]');
      if (cancelar) {
        const motivo = await VF.ui.preguntar('Cancelar visita anunciada', 'Motivo (opcional)', { textoSi: 'Cancelar la visita' });
        try {
          await VF.api.borrar('/api/preregistros/' + cancelar.dataset.cancelar);
          VF.ui.aviso('exito', 'Visita cancelada' + (motivo ? ': ' + motivo : ''));
          cargar();
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo cancelar', e.message);
        }
      }
    });

    await cargar();
  },
});
