/* Same-origin, parent-controlled tray. No stock app, storage, bridge, or tower. */
(() => {
  'use strict';
  const protocol = 'singularity-dice-v1';
  const channel = new URLSearchParams(location.hash.slice(1)).get('channel');
  const origin = location.origin;
  const $ = id => document.getElementById(id);
  let renderer, gesture, config, pending, busy = false, holding = false, settled = false;
  let height = 18, displayed = null;
  const send = (type, payload = {}) => {
    if (channel && origin !== 'null' && parent !== window) parent.postMessage({ protocol, channel, type, ...payload }, origin);
  };
  function fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    $('error').textContent = message; $('error').hidden = false;
    send('error', { message });
  }
  function sync() {
    const locked = !renderer || !config || config.disabled || busy || holding;
    $('material').disabled = locked; $('height').disabled = locked;
    $('roll').disabled = locked; $('tray').disabled = !renderer || !config || config.disabled || busy;
    $('roll').textContent = busy ? '等待落定…' : settled ? '重新悬起' : `掷 D${config?.sides ?? 6}`;
    $('die-name').textContent = `D${config?.displayResult?.sides ?? config?.sides ?? 6}`;
    $('persona').textContent = config?.persona === 'witness' ? '见证者 · 月亮' : '玩家 · 群星';
    $('tray').setAttribute('aria-label', settled ? '重新悬起骰子' : `按住调整高度，松手掷 D${config?.sides ?? 6}`);
    const official = !!config?.displayResult;
    document.querySelector('.height').hidden = official;
    $('roll').hidden = official;
    if (official) { $('hint').textContent = '见证者发布的正式结果'; $('tray').setAttribute('aria-label', '正式判定骰面'); }
    else if (config?.disabled && !busy) $('hint').textContent = '等待下一次投掷';
  }
  function arm() {
    settled = false; displayed = null;
    renderer.clearCelestial(); renderer.releaseHeight = height / 3;
    renderer.prepareThrow(config.sides); renderer.fitReleaseHeight(28 / 3);
    $('result').textContent = '—'; $('pair').textContent = '';
    $('hint').textContent = '移动选位置，按住调高度，松手投掷。也可点击掷骰按钮。';
    $('error').hidden = true; sync();
  }
  function show(record) {
    $('result').textContent = record.value;
    $('pair').textContent = record.sides === 100 ? `${String(record.tens).padStart(2, '0')} + ${record.units}（00 + 0 计作 100）` : '';
    $('hint').textContent = '骰子已落定';
    renderer.showCelestial({ ...record, persona: config.persona });
    renderer.setCloseup(true); settled = true; sync();
  }
  async function roll(launch) {
    if (!config || config.disabled || busy || holding || settled) return;
    const captured = { ...config }, material = $('material').value, seed = Date.now();
    busy = true; $('error').hidden = true; $('result').textContent = '…'; $('pair').textContent = '';
    $('hint').textContent = '骰子正在落定…'; sync();
    try {
      launch = DiceCore.normalizeLaunch(launch || { control: 'tray-bowl-v12', atX: 0, atY: 0, height, heightMode: 'fixed', randomSeed: DiceRandom.seed() });
      renderer.clearCelestial();
      const simulation = await renderer.set(captured.sides, [], true, seed, launch);
      if (!simulation.valid || !simulation.result) throw new Error(simulation.reason || '骰子未能落定，请重新掷骰');
      const record = {
        ...simulation.result, id: `${seed}-${crypto.randomUUID()}`, persona: captured.persona,
        material, launch, day: DiceCore.dayKey(seed), localTime: DiceCore.localTime(seed),
        source: 'ui', schemaVersion: 1,
        ...(captured.requestId !== undefined ? { requestId: captured.requestId } : {}),
        ...(captured.rollId !== undefined ? { rollId: captured.rollId } : {}),
      };
      // Only renderer.set's physical result reaches the parent. Presentation is separate.
      send('result', { record });
      show(record);
    } catch (error) {
      settled = true; $('result').textContent = '—'; $('pair').textContent = '';
      $('hint').textContent = '本次不计。重新悬起后再试。'; fail(error);
    } finally {
      busy = false; sync();
      if (pending) { const next = pending; pending = null; configure(next); }
    }
  }
  function validResult(r) {
    return r && typeof r.id === 'string' && DiceCore.SIDES.includes(r.sides) && Number.isSafeInteger(r.seed)
      && Number.isInteger(r.value) && r.value >= 1 && r.value <= r.sides && DiceMaterials.trayIds.includes(r.material)
      && (r.sides !== 100 || Number.isInteger(r.tens) && r.tens >= 0 && r.tens <= 90 && r.tens % 10 === 0
        && Number.isInteger(r.units) && r.units >= 0 && r.units <= 9 && (r.tens + r.units || 100) === r.value);
  }
  function configure(next) {
    if (!next || !['witness', 'player'].includes(next.persona) || !DiceCore.SIDES.includes(next.sides)
      || typeof next.disabled !== 'boolean' || ![next.requestId, next.rollId].every(v => v === undefined || typeof v === 'string')
      || next.displayResult != null && !validResult(next.displayResult)) { fail(new Error('骰盘配置无效')); return; }
    if (busy) { pending = next; return; }
    gesture?.cancel();
    const previous = config; config = next;
    if (!previous || previous.persona !== next.persona) renderer.setPersona(next.persona);
    const displayKey = next.displayResult ? JSON.stringify(next.displayResult) : null;
    if (displayKey !== displayed && next.displayResult) {
      const record = next.displayResult;
      renderer.setMaterial(record.material); $('material').value = record.material;
      const values = record.sides === 100 ? [record.tens, record.units] : [record.value];
      // An authoritative result is positioned directly: no simulation and no callback.
      renderer.set(record.sides, values, false).then(() => {
        if (config !== next) return;
        show(record); displayed = displayKey; $('die-name').textContent = `D${record.sides}`;
      }).catch(fail);
    } else if (!next.displayResult && (!previous || previous.displayResult || previous.sides !== next.sides
      || previous.persona !== next.persona || previous.requestId !== next.requestId || previous.rollId !== next.rollId)) arm();
    else if (next.displayResult && previous?.persona !== next.persona) show(next.displayResult);
    sync();
  }
  window.addEventListener('message', event => {
    if (event.origin !== origin || event.source !== parent || !channel) return;
    const data = event.data;
    if (!data || data.protocol !== protocol || data.channel !== channel || data.type !== 'configure') return;
    try { if (renderer) configure(data.config); } catch (error) { fail(error); }
  });
  try {
    if (origin === 'null' || !channel || parent === window) throw new Error('请从地图编辑器打开骰盘；需要 HTTP 服务及 dice 静态资源。');
    renderer = new WoodDice($('scene'));
    // Fixed indoor illumination: no network weather or location request.
    renderer.setWeather({ isDay: true, cloud: 45, precipitation: 0, code: 2, phase: .5 });
    const setHeight = value => { height = value; $('height').value = String(value); $('height-value').textContent = `${value} cm`; };
    gesture = DiceGesture.attachHeight({ target: $('tray'), canvas: $('scene'), renderer, hint: $('hint'),
      canStart: () => !!config && !config.disabled && !busy && !holding && !settled,
      getHeight: () => height, onHeight: setHeight,
      onHold: value => { holding = value; sync(); }, onThrow: roll,
    });
    $('height').addEventListener('input', () => { setHeight(Number($('height').value)); arm(); });
    $('material').addEventListener('change', () => { try { renderer.setMaterial($('material').value); arm(); } catch (error) { fail(error); } });
    $('roll').addEventListener('click', () => { if (settled) arm(); else void roll(); });
    $('tray').addEventListener('click', () => { if (settled && !config.disabled && !busy) arm(); });
    window.addEventListener('error', event => fail(new Error(event.message || '骰盘加载失败，请刷新后重试')));
    $('scene').addEventListener('webglcontextlost', () => { config = config && { ...config, disabled: true }; sync(); fail(new Error('三维画面已中断，请重新打开骰盘')); });
    send('ready');
  } catch (error) { fail(error); }
})();
