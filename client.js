/**
 * dsh-markji-bridge - browser half.
 *
 * Adds the configuration section to this bundle's page under Plugins
 * (Plugins -> dsh-markji-bridge), via the plugins.bundle.config slot. The API
 * Key is write-only from this page: it is sent once to the Host, encrypted into
 * cache.db, and the page only ever receives hasKey plus the last four chars.
 * The cache location is a directory picker; changing it copies cache.db to the
 * new directory (the old files stay for rollback) and asks for a DSH restart.
 */
window.__ModuleLoader__.load({
  id: 'dsh-markji-bridge',
  factory: function (require) {
    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;

    var ROUTE = '/api/dsh-markji-bridge/settings';

    var STRINGS = {
      zh: {
        title: 'Markji 桥',
        subtitle: 'Markji 卡片与缓存。API Key 只保存在本机加密缓存中，不写入配置文件。',
        loading: '正在读取插件状态…',
        configured: '已配置 API Key',
        unconfigured: '未配置 API Key；缓存仍可读，云端调用会返回 not_configured。',
        keySection: 'API Key',
        keyHint: 'Markji 开放 API 的 64 位十六进制 Key。保存时会先校验，再加密写入 cache.db。',
        keyPlaceholder: '粘贴 64 位 API Key',
        keySavedPlaceholder: '已保存（尾号 ',
        saveTest: '保存并测试',
        test: '测试',
        clear: '清除 Key',
        testOk: 'API Key 测试通过（未修改已保存的 Key）。',
        testHint: '输入新 Key 可仅测试不保存；留空时测试已保存的 Key。',
        cacheSection: 'cache.db 位置',
        cacheHint: '当前生效目录。切换时会复制现有 cache.db（不移动，保留回退），需要重启 DSH 生效。',
        pick: '选择目录…',
        saveDir: '保存目录',
        active: '当前',
        defaultDir: '默认',
        savedDir: '已保存，重启后生效',
        cacheCards: '缓存卡片',
        lastSync: '最后同步',
        never: '从未',
        statusSection: '状态',
        refresh: '刷新状态',
        keyOk: 'API Key 已保存并通过测试。',
        keyCleared: 'API Key 已清除。',
        dirOk: '目录已保存；请重启 DSH 以使用新目录。',
        dirSame: '目录与当前目录相同，无需修改。',
        noPicker: '当前客户端不支持目录选择，请手动输入绝对路径。',
        pickerFail: '无法打开目录选择器，请手动输入绝对路径。',
        busy: '处理中…',
        confirmClear: '清除已保存的 API Key？清除后云端调用将返回 not_configured。',
        routeMissing: 'Host 设置接口不可用，请确认插件已启用并重启 DSH。',
      },
      en: {
        title: 'Markji Bridge',
        subtitle: 'Markji cards and cache. The API Key is stored only in the local encrypted cache, never in config files.',
        loading: 'Loading plugin status…',
        configured: 'API Key configured',
        unconfigured: 'No API Key. Cached reads still work; cloud calls return not_configured.',
        keySection: 'API Key',
        keyHint: '64-hex Markji OpenAPI key. It is tested first, then encrypted into cache.db.',
        keyPlaceholder: 'Paste the 64-hex API Key',
        keySavedPlaceholder: 'Saved (ends with ',
        saveTest: 'Save and test',
        test: 'Test',
        clear: 'Clear key',
        testOk: 'API Key test passed (the saved key was not changed).',
        testHint: 'Test a new key without saving, or leave blank to test the saved key.',
        cacheSection: 'cache.db location',
        cacheHint: 'Active directory. Changing it copies cache.db (keeping the old files for rollback); restart DSH to apply.',
        pick: 'Choose directory…',
        saveDir: 'Save directory',
        active: 'Active',
        defaultDir: 'Default',
        savedDir: 'Saved; takes effect after restart',
        cacheCards: 'Cached cards',
        lastSync: 'Last sync',
        never: 'never',
        statusSection: 'Status',
        refresh: 'Refresh',
        keyOk: 'API Key saved and tested.',
        keyCleared: 'API Key cleared.',
        dirOk: 'Directory saved; restart DSH to use it.',
        dirSame: 'The directory is already active.',
        noPicker: 'This client cannot open a directory picker; type an absolute path.',
        pickerFail: 'Could not open the directory picker; type an absolute path.',
        busy: 'Working…',
        confirmClear: 'Clear the saved API Key? Cloud calls will return not_configured afterwards.',
        routeMissing: 'Host settings route unavailable; make sure the plugin is enabled and restart DSH.',
      },
    };

    function detectLang() {
      try {
        var nav = typeof navigator !== 'undefined' ? String(navigator.language || '') : '';
        return nav.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      } catch (error) {
        return 'en';
      }
    }

    var t = STRINGS[detectLang()];
    var pluginContext = null;

    var CSS = [
      '.dmb-wrap{display:flex;flex-direction:column;gap:14px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary,#202020)}',
      '.dmb-wrap *{box-sizing:border-box}',
      '.dmb-card{min-width:0;border:1px solid var(--dsw-alias-border-l1,#d8d8d8);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dmb-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.dmb-title{font-weight:600;font-size:14px}',
      '.dmb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.dmb-wrap .dmb-input{flex:1 1 260px;min-width:0;width:100%;padding:7px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#aaa);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#202020);font-family:inherit;font-size:13px}',
      '.dmb-input::placeholder{color:var(--dsw-alias-label-secondary,#686868);opacity:1}',
      '.dmb-input:focus,.dmb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d8bff);outline-offset:2px}',
      '.dmb-wrap .dmb-btn{padding:6px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#aaa);background:var(--dsw-alias-bg-layer-2,#f1f1f1);color:var(--dsw-alias-label-primary,#202020);cursor:pointer;font-family:inherit;font-size:13px;line-height:1.5;white-space:nowrap}',
      '.dmb-wrap .dmb-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-primary,#202020)}',
      // Use an inverse text/surface pair: a theme's brand accent may itself be white.
      '.dmb-wrap .dmb-btn.primary{background:var(--dsw-alias-label-primary,#202020);border-color:transparent;color:var(--dsw-alias-bg-base,#fff)}',
      '.dmb-wrap .dmb-btn.danger{color:var(--dsw-alias-state-error-primary,#c52a32)}',
      '.dmb-wrap .dmb-btn:disabled{background:var(--dsw-alias-bg-layer-2,#f1f1f1);border-color:var(--dsw-alias-border-l1,#d8d8d8);color:var(--dsw-alias-label-secondary,#686868);opacity:1;cursor:not-allowed}',
      '.dmb-hint{color:var(--dsw-alias-label-secondary,#686868);line-height:1.5;font-size:12px;overflow-wrap:anywhere}',
      '.dmb-ok{color:var(--dsw-alias-state-success-primary,#218147);line-height:1.5;overflow-wrap:anywhere}',
      '.dmb-err{color:var(--dsw-alias-state-error-primary,#c52a32);line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dmb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:8px}',
      '.dmb-stat{min-width:0;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f1f1f1);border:1px solid var(--dsw-alias-border-l1,#d8d8d8)}',
      '.dmb-k{font-size:11px;color:var(--dsw-alias-label-secondary,#686868);margin-bottom:3px}',
      '.dmb-v{font-weight:600;overflow-wrap:anywhere}',
      '.dmb-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}',
      '.dmb-badge.on{background:rgba(48,164,108,.16);color:var(--dsw-alias-state-success-primary,#218147)}',
      '.dmb-badge.off{background:rgba(229,72,77,.14);color:var(--dsw-alias-state-error-primary,#c52a32)}',
      '.dmb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
    ].join('');

    function request(action, payload) {
      var init = { method: action ? 'POST' : 'GET', credentials: 'same-origin', headers: {} };
      if (action) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(Object.assign({ action: action }, payload || {}));
      }
      return fetch(ROUTE, init).then(function (response) {
        return response.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
          if (!response.ok || (data && data.ok === false)) {
            var message = data && data.error && data.error.message ? data.error.message : 'HTTP ' + response.status;
            if (response.status === 404) message = t.routeMissing;
            throw new Error(message);
          }
          return data;
        });
      });
    }

    function fmtTime(value) {
      if (!value) return t.never;
      var millis = typeof value === 'number' ? value : Date.parse(value);
      if (!Number.isFinite(millis)) return String(value);
      try { return new Date(millis).toLocaleString(); } catch (error) { return String(value); }
    }

    function Stat(props) {
      return h('div', { className: 'dmb-stat' }, h('div', { className: 'dmb-k' }, props.label), h('div', { className: 'dmb-v' }, props.value));
    }

    function SettingsPage(props) {
      var s = useState(null); var status = s[0], setStatus = s[1];
      var l = useState(true); var loading = l[0], setLoading = l[1];
      var e = useState(''); var error = e[0], setError = e[1];
      var n = useState(''); var notice = n[0], setNotice = n[1];
      var k = useState(''); var keyValue = k[0], setKeyValue = k[1];
      var b = useState(false); var busy = b[0], setBusy = b[1];
      var d = useState(''); var dirValue = d[0], setDirValue = d[1];
      var touchedDir = React.useRef(false);

      var refresh = useCallback(function () {
        setLoading(true);
        setError('');
        return request(null).then(function (data) {
          setStatus(data);
          if (!touchedDir.current) setDirValue((data && data.data_dir && data.data_dir.active) || '');
        }).catch(function (err) { setError(err && err.message ? err.message : String(err)); })
          .then(function () { setLoading(false); });
      }, []);

      useEffect(function () { refresh(); }, [refresh]);

      function run(promise, okMessage) {
        setBusy(true);
        setError('');
        setNotice('');
        return promise.then(function (result) {
          if (okMessage) setNotice(okMessage);
          return result;
        }).catch(function (err) {
          setError(err && err.message ? err.message : String(err));
        }).then(function () { setBusy(false); });
      }

      function saveKey() {
        var value = keyValue.trim();
        if (!/^[0-9a-fA-F]{64}$/.test(value)) {
          setError(t.keyHint);
          return;
        }
        run(request('setApiKey', { token: value }).then(function () {
          setKeyValue('');
          return refresh();
        }), t.keyOk);
      }

      function testKey() {
        var value = keyValue.trim();
        if ((value !== '' && !/^[0-9a-fA-F]{64}$/.test(value)) || (value === '' && !(status && status.key && status.key.configured))) {
          setError(t.keyHint);
          return;
        }
        run(request('testApiKey', value === '' ? {} : { token: value }), t.testOk);
      }

      function clearKey() {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t.confirmClear)) return;
        run(request('clearApiKey').then(refresh), t.keyCleared);
      }

      function saveDir() {
        var value = dirValue.trim();
        if (!value) { setError(t.cacheHint); return; }
        var active = status && status.data_dir ? status.data_dir.active : '';
        if (value === active) { setNotice(t.dirSame); return; }
        run(request('setDataDir', { dataDir: value }).then(function (result) {
          setNotice(t.dirOk);
          return request(null).then(function (data) {
            setStatus(data);
            setDirValue((data && data.data_dir && data.data_dir.saved) || value);
            return result;
          });
        }), null);
      }

      function pickDir() {
        var service = null;
        try {
          service = pluginContext && typeof pluginContext.get === 'function' ? pluginContext.get('uiWorkspace') : null;
        } catch (error) {
          service = null;
        }
        if (!service || typeof service.pickDirectory !== 'function') {
          setError(t.noPicker);
          return;
        }
        Promise.resolve()
          .then(function () { return service.pickDirectory(); })
          .then(function (value) {
            if (typeof value === 'string' && value !== '') {
              touchedDir.current = true;
              setDirValue(value);
              setError('');
            }
          })
          .catch(function (err) { setError(t.pickerFail + (err && err.message ? ' ' + err.message : '')); });
      }

      var key = status && status.key ? status.key : {};
      var dataDir = status && status.data_dir ? status.data_dir : {};
      var cards = status && status.cache && typeof status.cache.cards === 'number' ? status.cache.cards : null;
      var saved = dataDir.saved;
      var pending = Boolean(saved && saved !== dataDir.active);

      if (props && props.view === 'summary') {
        return h('span', null, key.configured ? t.configured : t.unconfigured);
      }

      return h('div', { className: 'dmb-wrap' },
        h('div', { className: 'dmb-card' },
          h('div', { className: 'dmb-head' },
            h('div', { className: 'dmb-title' }, t.statusSection),
            h('button', { type: 'button', className: 'dmb-btn', disabled: busy || loading, onClick: refresh }, t.refresh)
          ),
          error ? h('div', { className: 'dmb-err' }, error) : null,
          notice ? h('div', { className: 'dmb-ok' }, notice) : null,
          loading && status === null ? h('div', { className: 'dmb-hint' }, t.loading) : null,
          status ? h('div', { className: 'dmb-grid' },
            h(Stat, { label: t.keySection, value: h('span', { className: 'dmb-badge ' + (key.configured ? 'on' : 'off') }, key.configured ? t.configured : t.unconfigured) }),
            h(Stat, { label: t.cacheCards, value: cards === null ? '—' : String(cards) }),
            h(Stat, { label: t.lastSync, value: fmtTime(status.last_sync && (status.last_sync.finished_at || status.last_sync.started_at)) }),
            h(Stat, { label: 'cache.db', value: h('span', { className: 'dmb-mono' }, status.cache_file || '—') })
          ) : null
        ),

        h('div', { className: 'dmb-card' },
          h('div', { className: 'dmb-title' }, t.keySection),
          h('div', { className: 'dmb-hint' }, t.keyHint),
          h('div', { className: 'dmb-row' },
            h('input', {
              className: 'dmb-input',
              type: 'password',
              'aria-label': t.keySection,
              disabled: busy,
              value: keyValue,
              autoComplete: 'off',
              spellCheck: false,
              placeholder: key.configured && key.tail ? t.keySavedPlaceholder + key.tail + (t === STRINGS.zh ? '）' : ')') : t.keyPlaceholder,
              onChange: function (event) { setKeyValue(event.target.value); },
            })
          ),
          h('div', { className: 'dmb-hint' }, t.testHint),
          h('div', { className: 'dmb-row' },
            h('button', { type: 'button', className: 'dmb-btn primary', disabled: busy || keyValue.trim() === '', onClick: saveKey }, t.saveTest),
            h('button', { type: 'button', className: 'dmb-btn', disabled: busy || loading || (keyValue.trim() === '' && !key.configured), onClick: testKey }, t.test),
            h('button', { type: 'button', className: 'dmb-btn danger', disabled: busy || !key.configured, onClick: clearKey }, t.clear)
          )
        ),

        h('div', { className: 'dmb-card' },
          h('div', { className: 'dmb-title' }, t.cacheSection),
          h('div', { className: 'dmb-hint' }, t.cacheHint),
          h('div', { className: 'dmb-row' },
            h('input', {
              className: 'dmb-input dmb-mono',
              type: 'text',
              value: dirValue,
              'aria-label': t.cacheSection,
              disabled: busy,
              spellCheck: false,
              onChange: function (event) { touchedDir.current = true; setDirValue(event.target.value); },
            }),
            h('button', { type: 'button', className: 'dmb-btn', disabled: busy, onClick: pickDir }, t.pick),
            h('button', { type: 'button', className: 'dmb-btn primary', disabled: busy || loading || dirValue.trim() === '' || dirValue.trim() === (saved || dataDir.active), onClick: saveDir }, t.saveDir)
          ),
          h('div', { className: 'dmb-hint' },
            t.active + ': ' + (dataDir.active || '—') + ' · ' + t.defaultDir + ': ' + (dataDir.default || '—')
          ),
          pending ? h('div', { className: 'dmb-err' }, t.savedDir + ': ' + saved) : null
        )
      );
    }

    function apply(ctx) {
      pluginContext = ctx;
      ctx.effect(function () {
        var el = document.createElement('style');
        el.setAttribute('data-dsh-markji-bridge', 'settings');
        el.textContent = CSS;
        document.head.appendChild(el);
        return function () { if (el.parentNode) el.parentNode.removeChild(el); };
      }, 'dsh-markji-bridge:settings-styles');

      var slots = ctx.get('slots');
      if (!slots) return;
      // This is the bundle's own configuration page, keyed by its package name.
      // The plugin manager renders it between the description and the rows, so
      // the settings live with the plugin instead of in the separate Settings
      // dialog.
      slots.inject('plugins.bundle.config', function () {
        try {
          return slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-markji-bridge' },
            SettingsPage,
          );
        } catch (error) {
          return function () {};
        }
      });
    }

    return { name: 'dsh-markji-bridge', inject: ['slots'], apply: apply };
  },
});
