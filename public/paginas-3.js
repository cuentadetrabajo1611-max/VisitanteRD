/* ============================================================================
   VisitaFlow - Pantallas de vigilancia, reportes y gafetes
   ============================================================================ */

VF.paginas = VF.paginas || {};

/* ============================================================================
   GRAFICOS (SVG propio, sin librerias)
   ============================================================================ */

VF.grafico = (function () {
  /**
   * Normaliza los datos de entrada.
   *
   * Las series que arma el servidor llegan como { etiqueta, valor } y los
   * repartos como { etiqueta, n } (que es el alias que devuelve SQL Server).
   * En vez de obligar a cada gráfico a acordarse de cuál es cuál, se acepta
   * cualquiera de los dos nombres aquí, en un solo sitio.
   */
  function normalizar(datos) {
    return (datos || []).map((d) => ({
      etiqueta: d.etiqueta !== undefined && d.etiqueta !== null ? String(d.etiqueta) : '—',
      valor: Number(d.valor !== undefined ? d.valor : d.n) || 0,
    }));
  }

  /** Grafico de barras verticales. */
  function barras(entrada, opciones) {
    const o = opciones || {};
    const datos = normalizar(entrada);
    if (!datos.length) return VF.ui.vacio({ titulo: 'Sin datos en el periodo', icono: 'grafico' });

    const ancho = 700;
    const alto = o.alto || 190;
    const margen = { arriba: 16, derecha: 8, abajo: 26, izquierda: 34 };
    const areaAncho = ancho - margen.izquierda - margen.derecha;
    const areaAlto = alto - margen.arriba - margen.abajo;
    const maximo = Math.max.apply(null, datos.map((d) => d.valor)) || 1;

    const paso = areaAncho / datos.length;
    const anchoBarra = Math.max(2, Math.min(paso * 0.66, 34));

    let svg = '<svg viewBox="0 0 ' + ancho + ' ' + alto + '" role="img" aria-label="' + VF.ui.esc(o.titulo || 'Gráfico de barras') + '">';

    // Lineas guia y sus numeros
    for (let i = 0; i <= 3; i++) {
      const y = margen.arriba + (areaAlto / 3) * i;
      const valor = Math.round(maximo - (maximo / 3) * i);
      svg += '<line class="grafico__eje" x1="' + margen.izquierda + '" y1="' + y + '" x2="' + (ancho - margen.derecha) + '" y2="' + y + '"/>';
      svg += '<text class="grafico__texto" x="' + (margen.izquierda - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + valor + '</text>';
    }

    datos.forEach((d, i) => {
      const h = maximo ? (d.valor / maximo) * areaAlto : 0;
      const x = margen.izquierda + paso * i + (paso - anchoBarra) / 2;
      const y = margen.arriba + areaAlto - h;
      svg += '<rect class="grafico__barra" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + anchoBarra.toFixed(1) + '" height="' + Math.max(h, 0.6).toFixed(1) + '" rx="3">' +
        '<title>' + VF.ui.esc(d.etiqueta) + ': ' + d.valor + '</title></rect>';

      // Solo se rotulan algunas etiquetas, para que no se pisen.
      const cada = Math.ceil(datos.length / 12);
      if (i % cada === 0) {
        svg += '<text class="grafico__texto" x="' + (x + anchoBarra / 2).toFixed(1) + '" y="' + (alto - 8) + '" text-anchor="middle">' +
          VF.ui.esc(d.etiqueta) + '</text>';
      }
    });

    return svg + '</svg>';
  }

  /** Grafico de linea con area. */
  function linea(entrada, opciones) {
    const o = opciones || {};
    const datos = normalizar(entrada);
    if (!datos.length) return VF.ui.vacio({ titulo: 'Sin datos en el periodo', icono: 'grafico' });

    const ancho = 700;
    const alto = o.alto || 190;
    const margen = { arriba: 16, derecha: 10, abajo: 26, izquierda: 34 };
    const areaAncho = ancho - margen.izquierda - margen.derecha;
    const areaAlto = alto - margen.arriba - margen.abajo;
    const maximo = Math.max.apply(null, datos.map((d) => d.valor)) || 1;

    const x = (i) => margen.izquierda + (datos.length === 1 ? areaAncho / 2 : (areaAncho / (datos.length - 1)) * i);
    const y = (v) => margen.arriba + areaAlto - (v / maximo) * areaAlto;

    let svg = '<svg viewBox="0 0 ' + ancho + ' ' + alto + '" role="img" aria-label="' + VF.ui.esc(o.titulo || 'Gráfico de línea') + '">';

    for (let i = 0; i <= 3; i++) {
      const yy = margen.arriba + (areaAlto / 3) * i;
      const valor = Math.round(maximo - (maximo / 3) * i);
      svg += '<line class="grafico__eje" x1="' + margen.izquierda + '" y1="' + yy + '" x2="' + (ancho - margen.derecha) + '" y2="' + yy + '"/>';
      svg += '<text class="grafico__texto" x="' + (margen.izquierda - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' + valor + '</text>';
    }

    const puntos = datos.map((d, i) => x(i).toFixed(1) + ',' + y(d.valor).toFixed(1));
    svg += '<polygon class="grafico__area" points="' + margen.izquierda + ',' + (margen.arriba + areaAlto) + ' ' + puntos.join(' ') + ' ' + (ancho - margen.derecha) + ',' + (margen.arriba + areaAlto) + '"/>';
    svg += '<polyline class="grafico__linea" points="' + puntos.join(' ') + '"/>';

    const cada = Math.ceil(datos.length / 12);
    datos.forEach((d, i) => {
      if (i % cada === 0) {
        svg += '<text class="grafico__texto" x="' + x(i).toFixed(1) + '" y="' + (alto - 8) + '" text-anchor="middle">' + VF.ui.esc(d.etiqueta) + '</text>';
      }
    });

    return svg + '</svg>';
  }

  /** Reparto como barras horizontales: mejor que un pastel para comparar. */
  function barrasHorizontales(entrada, opciones) {
    const o = opciones || {};
    const datos = normalizar(entrada);
    if (!datos.length) return VF.ui.vacio({ titulo: 'Sin datos en el periodo', icono: 'grafico' });
    const maximo = Math.max.apply(null, datos.map((d) => d.valor)) || 1;
    const limite = o.limite || 8;
    return (
      '<div class="barras-h">' +
      datos.slice(0, limite).map((d) =>
        '<div class="barras-h__fila">' +
        '<div class="barras-h__etiqueta" title="' + VF.ui.esc(d.etiqueta) + '">' + VF.ui.esc(d.etiqueta) + '</div>' +
        '<div class="barras-h__pista"><div class="barras-h__valor" style="width:' + ((d.valor / maximo) * 100).toFixed(1) + '%"></div></div>' +
        '<div class="barras-h__numero">' + d.valor + '</div>' +
        '</div>').join('') +
      '</div>'
    );
  }

  /** Anillo de progreso (para porcentajes). */
  function anillo(valor, total, opciones) {
    const o = opciones || {};
    const pct = total ? Math.round((valor / total) * 100) : 0;
    const r = 42;
    const c = 2 * Math.PI * r;
    return (
      '<div class="texto-centro">' +
      '<svg viewBox="0 0 100 100" style="width:120px;height:120px;margin:0 auto">' +
      '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="var(--borde)" stroke-width="10"/>' +
      '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="var(--marca)" stroke-width="10" stroke-linecap="round" ' +
      'stroke-dasharray="' + ((pct / 100) * c).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 50 50)"/>' +
      '<text x="50" y="50" text-anchor="middle" dy="6" style="font-size:20px;font-weight:700;fill:var(--texto)">' + pct + '%</text>' +
      '</svg>' +
      (o.etiqueta ? '<div class="texto-chico texto-suave mt-1">' + VF.ui.esc(o.etiqueta) + '</div>' : '') +
      '</div>'
    );
  }

  return { barras, linea, barrasHorizontales, anillo };
})();

/* ============================================================================
   LISTA DE VIGILANCIA
   ============================================================================ */

VF.registrarRuta('vigilancia', {
  titulo: 'Lista de vigilancia',
  permiso: 'vigilancia.ver',
  async pintar(cont, params) {
    let pagina = 1;
    let filtros = { texto: params.texto || '', tipo: params.tipo || '', historial: params.historial === '1' ? '1' : '' };
    let verAvisos = false;

    async function cargar() {
      cont.innerHTML = VF.ui.cargando();

      const r = verAvisos
        ? await VF.api.get('/api/vigilancia/avisos' + VF.api.consulta({ pagina, tamano: 25, texto: filtros.texto }))
        : await VF.api.get('/api/vigilancia' + VF.api.consulta(Object.assign({}, filtros, { pagina, tamano: 25 })));

      if (!verAvisos) VF.barra.establecerInsignias({ bloqueados: filtros.historial || filtros.texto ? undefined : r.resumen.bloqueados });

      VF.cabecera(
        'Lista de vigilancia',
        'Cédulas bloqueadas (no entran) y observadas (entran, con aviso a recepción)',
        VF.tiene('vigilancia.editar') ? '<button class="boton" id="agregar">' + VF.icono.svg('mas') + 'Agregar cédula</button>' : ''
      );

      const res = r.resumen || {};

      cont.innerHTML =
        (verAvisos ? '' :
          '<div class="rejilla rejilla--metricas mb-3">' +
          metrica('Bloqueados', res.bloqueados, 'no pueden registrar entrada', res.bloqueados > 0 ? 'peligro' : '') +
          metrica('Observados', res.observados, 'entran con aviso', '') +
          metrica('Severidad alta', res.severidad_alta, 'requieren atención', res.severidad_alta > 0 ? 'alerta' : '') +
          metrica('Avisos esta semana', res.avisos_semana, 'mostrados en recepción') +
          metrica('Permitidos este mes', res.permitidos_mes, 'bloqueados que entraron con autorización') +
          '</div>') +

        '<div class="pestanas" role="tablist">' +
        '<button class="pestana" role="tab" data-vista="lista" aria-selected="' + (!verAvisos) + '">Lista</button>' +
        '<button class="pestana" role="tab" data-vista="avisos" aria-selected="' + verAvisos + '">Bitácora de avisos</button>' +
        '</div>' +

        barraFiltros(cont, {
          texto: filtros.texto,
          placeholder: verAvisos ? 'Buscar por cédula…' : 'Cédula, nombre o motivo…',
          controles: verAvisos ? '' :
            '<select class="selector" id="f-tipo" style="max-width:170px">' +
            '<option value="">Todos los tipos</option>' +
            '<option value="bloqueado"' + (filtros.tipo === 'bloqueado' ? ' selected' : '') + '>Bloqueados</option>' +
            '<option value="observado"' + (filtros.tipo === 'observado' ? ' selected' : '') + '>Observados</option>' +
            '</select>',
          extra: verAvisos ? '' :
            '<label class="campo campo--interruptor mb-0"><input type="checkbox" class="interruptor" id="f-historial"' +
            (filtros.historial ? ' checked' : '') + '><span class="texto-chico">Incluir levantados (historial)</span></label>',
        }) +

        (verAvisos ? tablaAvisos(r.listado) : (r.listado.filas.length ? tablaLista(r.listado) : VF.ui.vacio({
          titulo: 'La lista está vacía',
          texto: 'Aquí se registran las cédulas que no deben entrar y las que deben entrar con aviso. Los registros no se borran: se levantan y queda el historial.',
          icono: 'escudo',
          accion: VF.tiene('vigilancia.editar') ? { clave: 'agregar', texto: 'Agregar una cédula' } : null,
        }))) +
        (!verAvisos && r.listado.filas.length ? paginador(r.listado, (p) => { pagina = p; cargar(); }) : '');

      function metrica(etiqueta, valor, nota, tipo) {
        return '<div class="metrica ' + (tipo ? 'metrica--' + tipo : '') + '">' +
          '<div class="metrica__etiqueta">' + VF.ui.esc(etiqueta) + '</div>' +
          '<div class="metrica__valor">' + (valor || 0) + '</div>' +
          '<div class="metrica__nota">' + VF.ui.esc(nota) + '</div></div>';
      }

      function tablaLista(l) {
        return '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
          '<th>Cédula</th><th>Nombre</th><th>Tipo</th><th>Motivo</th><th>Vigencia</th><th>Avisos</th><th></th>' +
          '</tr></thead><tbody>' +
          l.filas.map((v) => {
            const levantado = !v.activo;
            return '<tr' + (levantado ? ' style="opacity:.6"' : '') + '>' +
              '<td class="texto-mono">' + VF.ui.esc(v.cedula_formato) + '</td>' +
              '<td>' + VF.ui.esc(v.nombre || '—') + '</td>' +
              '<td>' + (v.tipo === 'bloqueado'
                ? '<span class="etiqueta etiqueta--peligro">Bloqueado</span>'
                : '<span class="etiqueta etiqueta--pendiente">Observado</span>') +
              (v.severidad === 'alta' ? ' <span class="etiqueta">Alta</span>' : '') + '</td>' +
              '<td class="texto-chico">' + VF.ui.esc(v.motivo) +
              (v.autorizado_por ? '<div class="tabla__secundario">Autorizó: ' + VF.ui.esc(v.autorizado_por) + '</div>' : '') + '</td>' +
              '<td class="texto-chico">' +
              (levantado
                ? '<span class="etiqueta">Levantado</span><div class="tabla__secundario">' + VF.ui.esc(v.levantado_legible || '') + '</div>' +
                  (v.levantado_motivo ? '<div class="tabla__secundario">' + VF.ui.esc(v.levantado_motivo) + '</div>' : '')
                : v.vigente_hasta_legible
                ? 'Hasta ' + VF.ui.esc(v.vigente_hasta_legible)
                : 'Sin vencimiento') + '</td>' +
              '<td class="tabla__numero">' + v.avisos + '</td>' +
              '<td><div class="tabla__acciones">' +
              (v.activo && VF.tiene('vigilancia.editar')
                ? '<button class="boton boton--fantasma boton--chico" data-editar="' + v.id + '" title="Editar">' + VF.icono.svg('editar') + '</button>' +
                  '<button class="boton boton--secundario boton--chico" data-levantar="' + v.id + '">Levantar</button>'
                : '') +
              '</div></td></tr>';
          }).join('') +
          '</tbody></table></div></div>';
      }

      function tablaAvisos(l) {
        if (!l.filas.length) {
          return VF.ui.vacio({ titulo: 'No hay avisos registrados', texto: 'Cada vez que recepción vea un aviso de la lista de vigilancia, quedará anotado aquí con la decisión que tomó.', icono: 'escudo' });
        }
        return '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
          '<th>Fecha</th><th>Cédula</th><th>Visitante</th><th>Decisión</th><th>Motivo</th><th>Operador</th>' +
          '</tr></thead><tbody>' +
          l.filas.map((a) => '<tr>' +
            '<td class="texto-chico">' + VF.ui.esc(VF.ui.fecha(a.fecha, true)) + '</td>' +
            '<td class="texto-mono">' + VF.ui.esc(a.cedula_formato) + '</td>' +
            '<td>' + VF.ui.esc(a.nombre || '—') + '</td>' +
            '<td>' + ({ avisado: '<span class="etiqueta etiqueta--pendiente">Avisado</span>',
                        permitido: '<span class="etiqueta etiqueta--dentro">Permitido</span>',
                        denegado: '<span class="etiqueta etiqueta--peligro">Denegado</span>' }[a.decision] || VF.ui.esc(a.decision)) + '</td>' +
            '<td class="texto-chico">' + VF.ui.esc(a.motivo || '—') + '</td>' +
            '<td class="texto-chico">' + VF.ui.esc(a.operador || '—') + '</td>' +
            '</tr>').join('') +
          '</tbody></table></div></div>';
      }

      const buscar = VF.ui.rebote(() => { filtros.texto = document.getElementById('f-texto').value.trim(); pagina = 1; cargar(); }, 350);
      document.getElementById('f-texto').addEventListener('input', buscar);

      const tipo = document.getElementById('f-tipo');
      if (tipo) tipo.addEventListener('change', (e) => { filtros.tipo = e.target.value; pagina = 1; cargar(); });

      const hist = document.getElementById('f-historial');
      if (hist) hist.addEventListener('change', (e) => { filtros.historial = e.target.checked ? '1' : ''; pagina = 1; cargar(); });

      cont.querySelectorAll('[data-vista]').forEach((b) => {
        b.addEventListener('click', () => { verAvisos = b.dataset.vista === 'avisos'; pagina = 1; cargar(); });
      });

      const agregar = document.getElementById('agregar');
      if (agregar) agregar.addEventListener('click', formularioAgregar);

      conectarPaginador(cont, (p) => { pagina = p; cargar(); });
    }

    function formularioAgregar(actual) {
      const a = actual || {};
      VF.ui.dialogo(
        actual ? 'Editar registro de vigilancia' : 'Agregar cédula a la lista',
        '<div class="aviso aviso--info">' + VF.icono.svg('info') +
        '<div class="texto-chico">La cédula se valida antes de guardarla. Bloquear por un error de tecleo dejaría a una persona inocente sin poder entrar.</div></div>' +
        '<div class="fila-campos">' +
        '<div class="campo"><label class="campo__etiqueta" for="v-cedula">Cédula <span class="req">*</span></label>' +
        '<input class="entrada entrada--grande" id="v-cedula" placeholder="001-0000001-7" value="' + VF.ui.esc(a.cedula_formato || '') + '"' +
        (actual ? ' readonly' : '') + '>' +
        '<div class="campo__ayuda" id="v-verif"></div></div>' +
        '<div class="campo"><label class="campo__etiqueta" for="v-nombre">Nombre</label>' +
        '<input class="entrada" id="v-nombre" value="' + VF.ui.esc(a.nombre || '') + '" placeholder="Se completa desde la base"></div>' +
        '</div>' +
        '<div class="fila-campos">' +
        '<div class="campo"><label class="campo__etiqueta" for="v-tipo">Tipo <span class="req">*</span></label>' +
        '<select class="selector" id="v-tipo">' +
        '<option value="bloqueado"' + (a.tipo === 'bloqueado' ? ' selected' : '') + '>Bloqueado — no puede entrar</option>' +
        '<option value="observado"' + (a.tipo === 'observado' || !a.tipo ? ' selected' : '') + '>Observado — entra con aviso</option>' +
        '</select></div>' +
        '<div class="campo"><label class="campo__etiqueta" for="v-severidad">Severidad</label>' +
        '<select class="selector" id="v-severidad">' +
        ['baja', 'media', 'alta'].map((s) => '<option value="' + s + '"' + (a.severidad === s || (!a.severidad && s === 'media') ? ' selected' : '') + '>' +
          s.charAt(0).toUpperCase() + s.slice(1) + '</option>').join('') +
        '</select></div>' +
        '</div>' +
        '<div class="campo"><label class="campo__etiqueta" for="v-motivo">Motivo <span class="req">*</span></label>' +
        '<textarea class="area" id="v-motivo" placeholder="Es lo que verá recepción cuando aparezca el aviso">' + VF.ui.esc(a.motivo || '') + '</textarea>' +
        '<div class="campo__ayuda">Escriba el motivo de forma que recepción entienda qué hacer.</div></div>' +
        '<div class="fila-campos">' +
        '<div class="campo"><label class="campo__etiqueta" for="v-autoriza">Autorizado por</label>' +
        '<input class="entrada" id="v-autoriza" value="' + VF.ui.esc(a.autorizado_por || '') + '" placeholder="Quién lo pide"></div>' +
        '<div class="campo"><label class="campo__etiqueta" for="v-hasta">Vigente hasta</label>' +
        '<input class="entrada" type="date" id="v-hasta" value="' + VF.ui.esc(a.vigente_hasta ? String(a.vigente_hasta).slice(0, 10) : '') + '">' +
        '<div class="campo__ayuda">Vacío = sin vencimiento.</div></div>' +
        '</div>',
        {
          pie:
            '<button class="boton boton--secundario" data-cerrar>Cancelar</button>' +
            '<button class="boton ' + (a.tipo === 'bloqueado' ? 'boton--peligro' : '') + '" id="v-guardar">' +
            (actual ? 'Guardar cambios' : 'Agregar a la lista') + '</button>',
        }
      );

      const campoCedula = document.getElementById('v-cedula');
      const verif = document.getElementById('v-verif');

      // Al completar la cedula se consulta la base y se trae el nombre.
      if (!actual) {
        campoCedula.addEventListener('input', () => {
          const d = campoCedula.value.replace(/\D/g, '').slice(0, 11);
          campoCedula.value = d.length > 10 ? d.slice(0, 3) + '-' + d.slice(3, 10) + '-' + d.slice(10) : d;
        });
        campoCedula.addEventListener('blur', async () => {
          const d = campoCedula.value.replace(/\D/g, '');
          if (d.length !== 11) { verif.textContent = ''; return; }
          verif.textContent = 'Consultando…';
          try {
            const r = await VF.api.get('/api/registro/buscar' + VF.api.consulta({ q: d }));
            if (r.resultados && r.resultados.length) {
              document.getElementById('v-nombre').value = r.resultados[0].nombre_completo || '';
              verif.innerHTML = '<span style="color:var(--dentro)">✓ Verificada en la base</span>';
            } else {
              verif.innerHTML = '<span style="color:var(--pendiente)">No está en la base. Puede agregarla igual, con el nombre a mano.</span>';
            }
          } catch (e) {
            verif.textContent = '';
          }
        });
      }

      document.getElementById('v-guardar').addEventListener('click', async () => {
        const datos = {
          cedula: document.getElementById('v-cedula').value.replace(/\D/g, ''),
          nombre: document.getElementById('v-nombre').value.trim(),
          tipo: document.getElementById('v-tipo').value,
          severidad: document.getElementById('v-severidad').value,
          motivo: document.getElementById('v-motivo').value.trim(),
          autorizado_por: document.getElementById('v-autoriza').value.trim(),
          vigente_hasta: document.getElementById('v-hasta').value || null,
        };
        if (!datos.motivo) {
          VF.ui.aviso('aviso', 'Falta el motivo', 'El motivo es lo que verá recepción. Escríbalo.');
          return;
        }
        try {
          if (actual) {
            await VF.api.patch('/api/vigilancia/' + actual.id, datos);
            VF.ui.aviso('exito', 'Registro actualizado');
          } else {
            const r = await VF.api.post('/api/vigilancia', datos);
            VF.ui.aviso('exito', 'Cédula agregada', (r.nombre || '') + (r.aviso ? ' — ' + r.aviso : ''), 9000);
          }
          document.querySelector('.dialogo').close();
          cargar();
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo guardar', e.message);
        }
      });
    }

    cont.addEventListener('click', async (ev) => {
      if (ev.target.closest('[data-accion="agregar"]')) return formularioAgregar();

      const levantar = ev.target.closest('[data-levantar]');
      if (levantar) {
        const motivo = await VF.ui.preguntar(
          'Levantar el registro',
          '¿Por qué se levanta?',
          { textoSi: 'Levantar', area: true, ayuda: 'El registro no se borra: queda el historial de que estuvo vigente.' }
        );
        if (!motivo) return;
        try {
          await VF.api.borrar('/api/vigilancia/' + levantar.dataset.levantar, { motivo });
          VF.ui.aviso('exito', 'Registro levantado', 'Queda en el historial.');
          cargar();
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo levantar', e.message);
        }
        return;
      }

      const editar = ev.target.closest('[data-editar]');
      if (editar) {
        try {
          const r = await VF.api.get('/api/vigilancia?historial=1&tamano=200');
          const v = r.listado.filas.find((x) => String(x.id) === String(editar.dataset.editar));
          if (v) formularioAgregar(v);
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo abrir', e.message);
        }
      }
    });

    await cargar();
  },
});

/* ============================================================================
   REPORTES
   ============================================================================ */

VF.registrarRuta('reportes', {
  titulo: 'Reportes',
  permiso: 'reportes.ver',
  async pintar(cont, params) {
    let filtros = {
      desde: params.desde || VF.ui.hoyMenos(29),
      hasta: params.hasta || VF.ui.hoyMenos(0),
      departamento_id: params.departamento_id || '',
      motivo_id: params.motivo_id || '',
      texto: params.texto || '',
    };
    let pestana = params.ver === 'visitantes' ? 'visitantes' : 'panel';
    let paginaDetalle = 1;
    let opciones = null;

    function periodo(valor) {
      const hoy = VF.ui.hoyMenos(0);
      if (valor === 'hoy') return { desde: hoy, hasta: hoy };
      return { desde: VF.ui.hoyMenos(Number(valor)), hasta: hoy };
    }

    async function cargar() {
      cont.innerHTML = VF.ui.cargando();

      const r = await VF.api.get('/api/reportes/resumen' + VF.api.consulta({
        desde: filtros.desde, hasta: filtros.hasta,
        departamento_id: filtros.departamento_id, motivo_id: filtros.motivo_id, texto: filtros.texto,
      }));
      opciones = r.opciones;
      const rep = r.reporte;
      const m = rep.metricas;

      VF.cabecera(
        'Reportes',
        'Del ' + rep.rango.desde + ' al ' + rep.rango.hasta,
        VF.tiene('reportes.exportar')
          ? '<button class="boton boton--secundario" id="exportar">' + VF.icono.svg('descargar') + 'Exportar CSV</button>'
          : ''
      );

      const controles =
        '<div class="fila fila--envuelve mb-2">' +
        '<div class="fila">' +
        '<input class="entrada" type="date" id="r-desde" value="' + VF.ui.esc(filtros.desde) + '" style="max-width:158px">' +
        '<span class="texto-suave texto-chico">hasta</span>' +
        '<input class="entrada" type="date" id="r-hasta" value="' + VF.ui.esc(filtros.hasta) + '" style="max-width:158px">' +
        '</div>' +
        '<div class="fila">' +
        opciones.periodos.map((p) => '<button class="boton boton--secundario boton--chico" data-periodo="' + p.valor + '">' + VF.ui.esc(p.etiqueta) + '</button>').join('') +
        '</div>' +
        '<span class="crecer"></span>' +
        '<select class="selector" id="r-depto" style="max-width:210px"><option value="">Todos los departamentos</option>' +
        opciones.departamentos.map((d) => '<option value="' + d.id + '"' + (String(filtros.departamento_id) === String(d.id) ? ' selected' : '') + '>' + VF.ui.esc(d.nombre) + '</option>').join('') +
        '</select>' +
        '<select class="selector" id="r-motivo" style="max-width:210px"><option value="">Todos los motivos</option>' +
        opciones.motivos.map((x) => '<option value="' + x.id + '"' + (String(filtros.motivo_id) === String(x.id) ? ' selected' : '') + '>' + VF.ui.esc(x.nombre) + '</option>').join('') +
        '</select>' +
        '</div>';

      const alertas = [];
      if (r.largas.filas.length) {
        alertas.push(
          '<div class="aviso aviso--aviso">' + VF.icono.svg('reloj') +
          '<div class="crecer"><strong>' + r.largas.filas.length + ' visita(s) llevan más de ' + r.largas.minutos_alerta + ' minutos dentro.</strong>' +
          '<div class="texto-chico">' + r.largas.filas.slice(0, 3).map((v) => VF.ui.esc(v.nombre) + ' (' + VF.ui.esc(v.tiempo) + ')').join(' · ') + '</div></div>' +
          '<a class="boton boton--secundario boton--chico" href="#/dentro?largas=1">Ver</a></div>'
        );
      }

      cont.innerHTML =
        controles + alertas.join('') +
        '<div class="pestanas" role="tablist">' +
        '<button class="pestana" role="tab" data-tab="panel" aria-selected="' + (pestana === 'panel') + '">Panel</button>' +
        '<button class="pestana" role="tab" data-tab="detalle" aria-selected="' + (pestana === 'detalle') + '">Detalle</button>' +
        '<button class="pestana" role="tab" data-tab="visitantes" aria-selected="' + (pestana === 'visitantes') + '">Visitantes frecuentes</button>' +
        '</div>' +
        '<div id="cuerpo-reporte"></div>';

      const cuerpo = document.getElementById('cuerpo-reporte');

      if (pestana === 'panel') {
        cuerpo.innerHTML =
          '<div class="rejilla rejilla--metricas mb-3">' +
          metrica('Visitas', m.visitas, 'en el periodo', '') +
          metrica('Personas distintas', m.visitantes_distintos, 'cédulas únicas', '') +
          metrica('Promedio por día', m.promedio_diario, 'visitas diarias', '') +
          metrica('Tiempo promedio', m.promedio_legible || '—', 'dentro de las instalaciones', '') +
          metrica('Visita más larga', m.maximo_legible || '—', 'duración máxima', m.maximo_minutos > r.largas.minutos_alerta ? 'alerta' : '') +
          metrica('Acompañantes', m.acompanantes, 'personas adicionales', '') +
          '</div>' +

          '<div class="rejilla rejilla--2 mb-3">' +
          '<div class="tarjeta"><div class="tarjeta__cabecera"><h2>Visitas por día</h2></div>' +
          '<div class="tarjeta__cuerpo">' + VF.grafico.linea(rep.series.por_dia, { titulo: 'Visitas por día' }) + '</div></div>' +
          '<div class="tarjeta"><div class="tarjeta__cabecera"><h2>Hora de mayor afluencia</h2></div>' +
          '<div class="tarjeta__cuerpo">' + VF.grafico.barras(rep.series.por_hora.filter((h) => h.valor > 0), { titulo: 'Visitas por hora' }) + '</div></div>' +
          '</div>' +

          '<div class="rejilla rejilla--3">' +
          '<div class="tarjeta"><div class="tarjeta__cabecera"><h3>Por departamento</h3></div>' +
          '<div class="tarjeta__cuerpo">' + VF.grafico.barrasHorizontales(rep.repartos.por_departamento) + '</div></div>' +
          '<div class="tarjeta"><div class="tarjeta__cabecera"><h3>Por motivo</h3></div>' +
          '<div class="tarjeta__cuerpo">' + VF.grafico.barrasHorizontales(rep.repartos.por_motivo) + '</div></div>' +
          '<div class="tarjeta"><div class="tarjeta__cabecera"><h3>Personas más visitadas</h3></div>' +
          '<div class="tarjeta__cuerpo">' + VF.grafico.barrasHorizontales(rep.repartos.personas_mas_visitadas) + '</div></div>' +
          '</div>' +

          '<div class="rejilla rejilla--2 mt-3">' +
          '<div class="tarjeta"><div class="tarjeta__cabecera"><h3>Por día de la semana</h3></div>' +
          '<div class="tarjeta__cuerpo">' + VF.grafico.barras(rep.series.por_dia_semana, { titulo: 'Visitas por día de la semana' }) + '</div></div>' +
          '<div class="tarjeta"><div class="tarjeta__cabecera"><h3>Empresas que más visitan</h3></div>' +
          '<div class="tarjeta__cuerpo">' + VF.grafico.barrasHorizontales(rep.repartos.por_empresa) + '</div></div>' +
          '</div>';
      } else if (pestana === 'detalle') {
        const d = await VF.api.get('/api/reportes/visitas' + VF.api.consulta(Object.assign({}, filtros, { pagina: paginaDetalle, tamano: 25 })));
        const l = d.listado;
        cuerpo.innerHTML = l.filas.length
          ? '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
            '<th>Visitante</th><th>Destino</th><th>Motivo</th><th>Entrada</th><th>Duración</th><th>Estado</th></tr></thead><tbody>' +
            l.filas.map((v) => '<tr>' +
              '<td><div class="tabla__principal">' + VF.ui.esc(v.nombre || '—') + '</div>' +
              '<div class="tabla__secundario">' + VF.ui.esc(v.cedula_formato || 'sin cédula') + '</div></td>' +
              '<td>' + VF.ui.esc(v.departamento || '—') + '<div class="tabla__secundario">' + VF.ui.esc(v.visitado || '') + '</div></td>' +
              '<td class="texto-chico">' + VF.ui.esc(v.motivo || '—') + '</td>' +
              '<td class="texto-chico">' + VF.ui.esc(VF.ui.fecha(v.entrada, true)) + '</td>' +
              '<td class="texto-chico">' + VF.ui.esc(v.duracion || '—') + '</td>' +
              '<td>' + VF.ui.estadoVisita(v.estado, v.requiere_aprobacion, v.aprobada) + '</td>' +
              '</tr>').join('') +
            '</tbody></table></div></div>' + paginador(l, (p) => { paginaDetalle = p; cargar(); })
          : VF.ui.vacio({ titulo: 'Sin visitas en ese rango', texto: 'Cambie las fechas o quite los filtros.', icono: 'bitacora' });
      } else {
        const v = await VF.api.get('/api/reportes/visitantes' + VF.api.consulta(Object.assign({}, filtros, { tamano: 30 })));
        const l = v.listado;
        cuerpo.innerHTML = l.filas.length
          ? '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
            '<th>Cédula</th><th>Nombre</th><th>Empresa</th><th class="texto-derecha">Visitas</th><th>Primera</th><th>Última</th></tr></thead><tbody>' +
            l.filas.map((x) => '<tr>' +
              '<td class="texto-mono">' + VF.ui.esc(x.cedula_formato) + '</td>' +
              '<td class="tabla__principal">' + VF.ui.esc(x.nombre || '—') + '</td>' +
              '<td class="texto-chico">' + VF.ui.esc(x.empresa || '—') + '</td>' +
              '<td class="tabla__numero negrita">' + x.visitas + '</td>' +
              '<td class="texto-chico">' + VF.ui.esc(x.primera_legible || '') + '</td>' +
              '<td class="texto-chico">' + VF.ui.esc(x.ultima_legible || '') + '</td>' +
              '</tr>').join('') +
            '</tbody></table></div></div>'
          : VF.ui.vacio({ titulo: 'Sin visitantes en ese rango', icono: 'personas' });
      }

      function metrica(etiqueta, valor, nota, tipo) {
        return '<div class="metrica ' + (tipo ? 'metrica--' + tipo : '') + '">' +
          '<div class="metrica__etiqueta">' + VF.ui.esc(etiqueta) + '</div>' +
          '<div class="metrica__valor">' + VF.ui.esc(valor) + '</div>' +
          '<div class="metrica__nota">' + VF.ui.esc(nota) + '</div></div>';
      }

      // Conexiones
      document.getElementById('r-desde').addEventListener('change', (e) => { filtros.desde = e.target.value; paginaDetalle = 1; cargar(); });
      document.getElementById('r-hasta').addEventListener('change', (e) => { filtros.hasta = e.target.value; paginaDetalle = 1; cargar(); });
      document.getElementById('r-depto').addEventListener('change', (e) => { filtros.departamento_id = e.target.value; paginaDetalle = 1; cargar(); });
      document.getElementById('r-motivo').addEventListener('change', (e) => { filtros.motivo_id = e.target.value; paginaDetalle = 1; cargar(); });

      cont.querySelectorAll('[data-periodo]').forEach((b) => {
        b.addEventListener('click', () => {
          Object.assign(filtros, periodo(b.dataset.periodo));
          paginaDetalle = 1;
          cargar();
        });
      });

      cont.querySelectorAll('[data-tab]').forEach((b) => {
        b.addEventListener('click', () => { pestana = b.dataset.tab; paginaDetalle = 1; cargar(); });
      });

      const exp = document.getElementById('exportar');
      if (exp) exp.addEventListener('click', () => {
        window.location.href = '/api/reportes/visitas.csv' + VF.api.consulta(filtros);
      });
    }

    await cargar();
  },
});

/* ============================================================================
   GAFETES
   ============================================================================ */

VF.registrarRuta('gafetes', {
  titulo: 'Gafetes',
  permiso: 'gafete.imprimir',
  async pintar(cont, params) {
    VF.cabecera('Gafetes', 'Emitidos y pendientes de devolver');

    async function cargar() {
      cont.innerHTML = VF.ui.cargando();
      const [p, pl] = await Promise.all([
        VF.api.get('/api/gafetes/pendientes'),
        VF.api.get('/api/gafetes/plantillas'),
      ]);

      cont.innerHTML =
        '<div class="rejilla rejilla--panel">' +
        '<div class="tarjeta">' +
        '<div class="tarjeta__cabecera"><h2>Gafetes sin devolver</h2>' +
        '<span class="etiqueta etiqueta--marca">' + p.gafetes.length + '</span></div>' +
        (p.gafetes.length
          ? '<div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
            '<th>Código</th><th>Visitante</th><th>Emitido</th><th>Impresiones</th><th>Estado visita</th><th></th>' +
            '</tr></thead><tbody>' +
            p.gafetes.map((g) => '<tr>' +
              '<td class="texto-mono">' + VF.ui.esc(g.codigo) + '</td>' +
              '<td class="tabla__principal">' + VF.ui.esc(g.nombre || '—') + '</td>' +
              '<td class="texto-chico">' + VF.ui.esc(VF.ui.fecha(g.emitido, true)) + '</td>' +
              '<td class="tabla__numero">' + g.veces_impreso + (g.impreso ? '' : ' <span class="etiqueta">sin imprimir</span>') + '</td>' +
              '<td>' + VF.ui.estadoVisita(g.estado_visita) + '</td>' +
              '<td class="texto-derecha"><button class="boton boton--secundario boton--chico" data-gafete="' + g.visita_id + '">Ver</button></td>' +
              '</tr>').join('') +
            '</tbody></table></div>'
          : VF.ui.vacio({
              titulo: 'No hay gafetes pendientes',
              texto: 'Aquí aparecen los gafetes emitidos que todavía no se han devuelto.',
              icono: 'gafete',
            })) +
        '</div>' +

        '<div>' +
        '<div class="tarjeta mb-2"><div class="tarjeta__cabecera"><h2>Plantillas</h2>' +
        (VF.tiene('gafete.disenar') ? '<button class="boton boton--secundario boton--chico" id="nueva-plantilla">' + VF.icono.svg('mas') + 'Nueva</button>' : '') +
        '</div><div class="tarjeta__cuerpo" id="plantillas"></div></div>' +
        '<div class="tarjeta"><div class="tarjeta__cabecera"><h2>Buscar un gafete</h2></div>' +
        '<div class="tarjeta__cuerpo">' +
        '<div class="campo"><label class="campo__etiqueta" for="codigo">Código de la visita</label>' +
        '<div class="campo-cedula"><input class="entrada" id="codigo" placeholder="VF-20261015-ABCD">' +
        '<button class="boton" id="buscar-codigo">' + VF.icono.svg('buscar') + '</button></div>' +
        '<div class="campo__ayuda">También sirve pasar el gafete por el lector: el campo recibe el código.</div></div>' +
        '</div></div>' +
        '</div>' +
        '</div>';

      document.getElementById('plantillas').innerHTML = pl.plantillas.length
        ? pl.plantillas.map((t) =>
            '<div class="fila fila--separada" style="padding:.5rem 0;border-bottom:1px solid var(--borde)">' +
            '<div><div class="negrita">' + VF.ui.esc(t.nombre) + '</div>' +
            '<div class="texto-chico texto-suave">' + VF.ui.esc((pl.tamanos[t.tamano] || {}).etiqueta || t.tamano) +
            (t.mostrar_qr ? ' · QR' : '') + (t.mostrar_barras ? ' · código de barras' : '') +
            (t.es_predeterminada ? ' · <strong>predeterminada</strong>' : '') + '</div></div>' +
            (VF.tiene('gafete.disenar')
              ? '<button class="boton boton--fantasma boton--chico" data-plantilla="' + t.id + '">' + VF.icono.svg('editar') + '</button>'
              : '') +
            '</div>').join('')
        : '<div class="texto-suave texto-chico">No hay plantillas.</div>';

      const buscarCodigo = async () => {
        const c = document.getElementById('codigo').value.trim();
        if (!c) return;
        try {
          // Se busca por el texto en la bitácora: el código de la visita es uno
          // de los campos que se filtran ahí, así que no hace falta otra ruta.
          const l = await VF.api.get('/api/visitas' + VF.api.consulta({ texto: c, tamano: 5 }));
          if (!l.listado.filas.length) {
            VF.ui.aviso('aviso', 'No se encontró', 'No hay ninguna visita con el código ' + c + '.');
            return;
          }
          VF.paginas.verGafete(l.listado.filas[0].id);
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo buscar', e.message);
        }
      };

      document.getElementById('buscar-codigo').addEventListener('click', buscarCodigo);
      document.getElementById('codigo').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') buscarCodigo(); });

      const nueva = document.getElementById('nueva-plantilla');
      if (nueva) nueva.addEventListener('click', () => VF.paginas.editarPlantilla(null, pl.tamanos, cargar));

      cont.querySelectorAll('[data-plantilla]').forEach((b) => {
        b.addEventListener('click', () => {
          const t = pl.plantillas.find((x) => String(x.id) === String(b.dataset.plantilla));
          VF.paginas.editarPlantilla(t, pl.tamanos, cargar);
        });
      });

      cont.querySelectorAll('[data-gafete]').forEach((b) => {
        b.addEventListener('click', () => VF.paginas.verGafete(b.dataset.gafete));
      });
    }

    await cargar();

    /* Si la direccion trae una visita (por ejemplo #/gafetes?gafete=12), se abre
       su gafete directamente. Sirve para enlazar a un gafete concreto y para las
       capturas de pantalla. */
    if (params.gafete) VF.paginas.verGafete(params.gafete);

    /* E imprimir de una vez, si la direccion lo pide:
         #/gafetes?imprimir=12&formato=termica
       Es lo que usa scripts/probar-impresion.js para comprobar el CSS de
       impresion de verdad, imprimiendo a PDF con el navegador sin interfaz. */
    if (params.imprimir) VF.paginas.verGafete(params.imprimir, { imprimir: params.formato || 'a4' });
  },
});

/** Vista previa del gafete con opcion de imprimir. */
VF.paginas.verGafete = async function (visitaId, opciones) {
  const opcionesVista = opciones || {};
  try {
    const r = await VF.api.get('/api/gafetes/visita/' + visitaId);
    const g = r.gafete;
    const p = g.plantilla || {};

    const anchoMm = p.ancho_mm || 105;
    const altoMm = p.alto_mm || 74;
    // Se pasa de milimetros a pixeles para la vista previa en pantalla.
    const px = (mm) => Math.round((mm / 25.4) * 96);

    const lineas = [
      ['Cédula', g.cedula],
      ['Visita a', g.visitado],
      ['Departamento', g.departamento],
      ['Motivo', g.motivo],
      ['Entrada', g.entrada_legible],
      ['Válido hasta', g.valido_hasta],
      g.acompanantes ? ['Acompañantes', g.acompanantes] : null,
      g.vehiculo ? ['Vehículo', g.vehiculo] : null,
    ].filter(Boolean);

    /* Solo el gafete, sin la envoltura: esto es lo que se manda a la ventana de
       impresión, que pone su propia página alrededor. */
    const htmlGafete =
      '<div class="gafete" id="gafete-vista" style="' +
      '--gafete-ancho:' + px(anchoMm) + 'px;--gafete-alto:' + px(altoMm) + 'px;' +
      '--gafete-marca:' + g.colores.primario + ';--gafete-sobre-marca:' + g.colores.texto_sobre_primario + ';' +
      '--gafete-fondo:' + g.colores.fondo + ';' + (g.colores.texto_plantilla ? '--gafete-texto:' + g.colores.texto_plantilla + ';' : '') +
      '">' +
      '<div class="gafete__franja">' +
      '<div class="gafete__logo">' +
      (g.institucion.logo_url ? '<img src="' + VF.ui.esc(g.institucion.logo_url) + '" alt="">' : VF.ui.esc(VF.ui.iniciales(g.institucion.nombre_comercial))) +
      '</div>' +
      '<div class="crecer"><div class="gafete__institucion">' + VF.ui.esc(g.institucion.nombre_comercial) + '</div>' +
      '<div class="gafete__tipo">Gafete de visitante</div></div>' +
      '</div>' +
      '<div class="gafete__cuerpo">' +
      '<div class="gafete__principal">' +
      '<div class="gafete__nombre">' + VF.ui.esc(g.nombre) + '</div>' +
      (g.cedula ? '<div class="gafete__cedula">' + VF.ui.esc(g.cedula) + '</div>' : '') +
      '<div class="gafete__lineas">' +
      lineas.map((l) => '<div class="gafete__linea"><span>' + VF.ui.esc(l[0]) + '</span><span>' + VF.ui.esc(l[1] || '—') + '</span></div>').join('') +
      '</div></div>' +
      '<div class="gafete__codigos">' +
      (g.codigos.qr_svg ? '<div class="gafete__qr">' + g.codigos.qr_svg + '</div>' : '') +
      (g.codigos.barras_svg ? '<div class="gafete__barras">' + g.codigos.barras_svg + '</div>' : '') +
      '<div class="gafete__codigo">' + VF.ui.esc(g.codigo) + '</div>' +
      '</div></div>' +
      '<div class="gafete__pie">' +
      '<span>' + VF.ui.esc(g.institucion.texto_pie || 'Conserve este gafete mientras esté en las instalaciones') + '</span>' +
      '<span>' + VF.ui.esc(g.codigo) + '</span>' +
      '</div></div>';

    // La vista previa en pantalla sí lleva la envoltura que lo centra.
    const html = '<div class="gafete-envoltura no-imprimir">' + htmlGafete + '</div>';

    /* Selector de formato de impresión. Va FUERA del área que se imprime: si
       estuviera dentro, saldría en el papel. */
    const selector =
      '<div class="no-imprimir" style="margin-top:1rem">' +
      '<div class="fila" style="gap:.8rem;align-items:flex-start;flex-wrap:wrap">' +
      '<div class="campo crecer" style="min-width:15rem"><label class="campo__etiqueta" for="formato-impresion">Formato de impresión</label>' +
      '<select class="entrada" id="formato-impresion">' +
      '<option value="a4">Hoja A4 (una por gafete)</option>' +
      '<option value="ajustado">Hoja A4, al tamaño del gafete</option>' +
      '<option value="termica">Impresora térmica de etiquetas</option>' +
      '</select></div>' +
      '<div class="campo" style="width:6.5rem"><label class="campo__etiqueta" for="copias-impresion">Copias</label>' +
      '<input class="entrada" type="number" id="copias-impresion" min="1" max="20" value="1"></div>' +
      '</div>' +
      '<div class="campo__ayuda" id="ayuda-impresion"></div></div>';

    const dlg = VF.ui.dialogo('Gafete de ' + g.nombre, html + selector, {
      pie:
        '<button class="boton boton--secundario" data-cerrar>Cerrar</button>' +
        '<button class="boton" id="imprimir-gafete">' + VF.icono.svg('imprimir') + 'Imprimir</button>',
    });

    /* --- Formato de impresión ------------------------------------------
       Se recuerda la elección en el navegador: la institución casi siempre usa
       la misma impresora, y elegirla en cada gafete sería una molestia. */
    const CLAVE_FORMATO = 'vf.formato-impresion';
    const sel = document.getElementById('formato-impresion');
    const copias = document.getElementById('copias-impresion');
    const ayuda = document.getElementById('ayuda-impresion');

    function formatoGuardado() {
      try {
        const v = localStorage.getItem(CLAVE_FORMATO);
        return ['a4', 'ajustado', 'termica'].indexOf(v) !== -1 ? v : 'a4';
      } catch (e) {
        return 'a4';
      }
    }

    function actualizarAyuda(formato) {
      if (formato === 'termica') {
        ayuda.textContent = 'La página se ajusta a la etiqueta de ' + anchoMm + ' × ' + altoMm +
          ' mm. En el diálogo de impresión elija su impresora de etiquetas.';
      } else if (formato === 'ajustado') {
        ayuda.textContent = 'El gafete sale a ' + anchoMm + ' × ' + altoMm +
          ' mm sobre la hoja, sin márgenes de más.';
      } else {
        ayuda.textContent = 'Una hoja por gafete, centrado. Es el formato que funciona con cualquier impresora.';
      }
    }

    sel.value = formatoGuardado();
    actualizarAyuda(sel.value);

    sel.addEventListener('change', () => {
      try { localStorage.setItem(CLAVE_FORMATO, sel.value); } catch (e) { /* da igual */ }
      actualizarAyuda(sel.value);
    });

    /** Anota la impresión y abre la ventana de impresión. */
    async function imprimir(formato) {
      /* Se anota la impresión ANTES de abrir la ventana: si el navegador
         cancela, queda anotado igual, y eso es lo correcto: el gafete ya se
         generó y alguien pudo imprimirlo. */
      try {
        await VF.api.post('/api/gafetes/visita/' + visitaId + '/impreso');
      } catch (e) {
        /* si no se puede anotar la impresion, no se impide imprimir */
      }

      VF.gafete.imprimir(formato, {
        visitaId: visitaId,
        copias: Number(copias.value) || 1,
      });
    }

    document.getElementById('imprimir-gafete').addEventListener('click', () => imprimir(sel.value));

    /* Impresión automática, si la dirección la pidió:
         #/gafetes?imprimir=12&formato=termica
       Es lo que usa scripts/probar-impresion.js. */
    if (opcionesVista.imprimir) {
      const formato = VF.gafete.FORMATOS[opcionesVista.imprimir] ? opcionesVista.imprimir : 'a4';
      sel.value = formato;
      actualizarAyuda(formato);
      setTimeout(() => imprimir(formato), 400);
    }
  } catch (e) {
    VF.ui.aviso('peligro', 'No se pudo abrir el gafete', e.message);
  }
};

/* ============================================================================
   Impresión del gafete
   ============================================================================ */

VF.gafete = VF.gafete || {};

/** Los tres formatos, con lo que hay que decirle a la página. */
VF.gafete.FORMATOS = {
  a4: { nombre: 'Hoja A4', pagina: 'A4', margen: '12mm' },
  ajustado: { nombre: 'A4 al tamaño del gafete', pagina: 'A4', margen: '6mm' },
  termica: { nombre: 'Etiqueta térmica', pagina: null, margen: '0' },
};

/**
 * Imprime el gafete.
 *
 * Abre una ventana con la HOJA DE IMPRESIÓN que genera el servidor: una página
 * que contiene solo el gafete y su propia regla @page. Esa regla es lo que hace
 * que una impresora térmica reciba una etiqueta del tamaño correcto en vez de
 * una hoja A4 escalada, y solo funciona si está en el documento ANTES de
 * imprimir (ver el comentario largo en src/impresion.js).
 *
 * No hace falta pasar el token: la hoja va con la cookie de sesión, que es
 * HttpOnly y SameSite=Lax, así que el navegador la manda en esta navegación
 * igual que en cualquier otra página.
 *
 * @param {string} formato  'a4' | 'ajustado' | 'termica'
 * @param {object} datos    { visitaId, copias }
 */
VF.gafete.imprimir = function (formato, datos) {
  const copias = Math.max(1, Math.min(20, Number(datos.copias) || 1));
  const url = '/api/gafetes/visita/' + encodeURIComponent(datos.visitaId) +
    '/hoja?formato=' + encodeURIComponent(formato) + '&copias=' + copias;

  const ventana = window.open(url, '_blank', 'width=900,height=760');
  if (!ventana) {
    VF.ui.aviso('aviso', 'El navegador bloqueó la ventana de impresión',
      'Permita las ventanas emergentes para este sitio y vuelva a intentarlo.');
  }
};

/** Editor de plantillas de gafete. */
VF.paginas.editarPlantilla = function (plantilla, tamanos, alGuardar) {
  const t = plantilla || { nombre: '', tamano: 'carta-4', orientacion: 'horizontal', mostrar_qr: true, mostrar_barras: false, es_predeterminada: false };
  VF.ui.dialogo(
    plantilla ? 'Editar plantilla' : 'Nueva plantilla de gafete',
    '<div class="fila-campos">' +
    '<div class="campo"><label class="campo__etiqueta" for="t-nombre">Nombre <span class="req">*</span></label>' +
    '<input class="entrada" id="t-nombre" value="' + VF.ui.esc(t.nombre) + '"></div>' +
    '<div class="campo"><label class="campo__etiqueta" for="t-tamano">Tamaño</label>' +
    '<select class="selector" id="t-tamano">' +
    Object.keys(tamanos).map((k) => '<option value="' + k + '"' + (t.tamano === k ? ' selected' : '') + '>' + VF.ui.esc(tamanos[k].etiqueta) + '</option>').join('') +
    '</select></div>' +
    '</div>' +
    '<div class="fila-campos fila-campos--3">' +
    '<div class="campo"><label class="campo__etiqueta" for="t-ancho">Ancho (mm)</label>' +
    '<input class="entrada" type="number" id="t-ancho" value="' + (t.ancho_mm || tamanos[t.tamano].ancho_mm) + '"></div>' +
    '<div class="campo"><label class="campo__etiqueta" for="t-alto">Alto (mm)</label>' +
    '<input class="entrada" type="number" id="t-alto" value="' + (t.alto_mm || tamanos[t.tamano].alto_mm) + '"></div>' +
    '<div class="campo"><label class="campo__etiqueta" for="t-orientacion">Orientación</label>' +
    '<select class="selector" id="t-orientacion">' +
    '<option value="horizontal"' + (t.orientacion === 'horizontal' ? ' selected' : '') + '>Horizontal</option>' +
    '<option value="vertical"' + (t.orientacion === 'vertical' ? ' selected' : '') + '>Vertical</option>' +
    '</select></div>' +
    '</div>' +
    '<div class="fila-campos">' +
    '<div class="campo"><label class="campo__etiqueta" for="t-fondo">Color de fondo</label>' +
    '<input class="entrada" type="color" id="t-fondo" value="' + VF.ui.esc(t.color_fondo || '#ffffff') + '"></div>' +
    '<div class="campo"><label class="campo__etiqueta" for="t-texto">Color del texto</label>' +
    '<input class="entrada" type="color" id="t-texto" value="' + VF.ui.esc(t.color_texto || '#0f172a') + '"></div>' +
    '</div>' +
    '<div class="campo"><label class="campo__etiqueta" for="t-pie">Texto al pie</label>' +
    '<input class="entrada" id="t-pie" value="' + VF.ui.esc(t.pie || '') + '" placeholder="Conserve este gafete mientras esté en las instalaciones"></div>' +
    '<label class="campo campo--interruptor"><input type="checkbox" class="interruptor" id="t-qr"' + (t.mostrar_qr ? ' checked' : '') + '><span>Código QR (para registrar la salida con lector)</span></label>' +
    '<label class="campo campo--interruptor"><input type="checkbox" class="interruptor" id="t-barras"' + (t.mostrar_barras ? ' checked' : '') + '><span>Código de barras Code 128</span></label>' +
    '<label class="campo campo--interruptor"><input type="checkbox" class="interruptor" id="t-pred"' + (t.es_predeterminada ? ' checked' : '') + '><span>Usar como plantilla predeterminada</span></label>',
    {
      pie:
        (plantilla ? '<button class="boton boton--peligro boton--chico" id="t-borrar">Desactivar</button><span class="crecer"></span>' : '') +
        '<button class="boton boton--secundario" data-cerrar>Cancelar</button>' +
        '<button class="boton" id="t-guardar">Guardar</button>',
    }
  );

  // Al cambiar el tamaño se ajustan las medidas sugeridas.
  document.getElementById('t-tamano').addEventListener('change', (e) => {
    const m = tamanos[e.target.value];
    document.getElementById('t-ancho').value = m.ancho_mm;
    document.getElementById('t-alto').value = m.alto_mm;
  });

  document.getElementById('t-guardar').addEventListener('click', async () => {
    const datos = {
      nombre: document.getElementById('t-nombre').value.trim(),
      tamano: document.getElementById('t-tamano').value,
      ancho_mm: document.getElementById('t-ancho').value,
      alto_mm: document.getElementById('t-alto').value,
      orientacion: document.getElementById('t-orientacion').value,
      color_fondo: document.getElementById('t-fondo').value,
      color_texto: document.getElementById('t-texto').value,
      pie: document.getElementById('t-pie').value.trim(),
      mostrar_qr: document.getElementById('t-qr').checked,
      mostrar_barras: document.getElementById('t-barras').checked,
      es_predeterminada: document.getElementById('t-pred').checked,
    };
    if (!datos.nombre) {
      VF.ui.aviso('aviso', 'Falta el nombre de la plantilla');
      return;
    }
    try {
      if (plantilla) await VF.api.patch('/api/gafetes/plantillas/' + plantilla.id, datos);
      else await VF.api.post('/api/gafetes/plantillas', datos);
      VF.ui.aviso('exito', 'Plantilla guardada');
      document.querySelector('.dialogo').close();
      if (alGuardar) alGuardar();
    } catch (e) {
      VF.ui.aviso('peligro', 'No se pudo guardar', e.message);
    }
  });

  const borrar = document.getElementById('t-borrar');
  if (borrar) {
    borrar.addEventListener('click', async () => {
      const ok = await VF.ui.confirmar('Desactivar plantilla', 'Los gafetes ya emitidos con esta plantilla siguen siendo válidos. La plantilla deja de ofrecerse para nuevos gafetes.', { peligro: true, textoSi: 'Desactivar' });
      if (!ok) return;
      try {
        await VF.api.borrar('/api/gafetes/plantillas/' + plantilla.id);
        VF.ui.aviso('exito', 'Plantilla desactivada');
        document.querySelector('.dialogo').close();
        if (alGuardar) alGuardar();
      } catch (e) {
        VF.ui.aviso('peligro', 'No se pudo desactivar', e.message);
      }
    });
  }
};
