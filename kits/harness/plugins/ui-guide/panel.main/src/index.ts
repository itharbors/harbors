type HarnessUI = { install(root: Document | ShadowRoot): void };

export default {
  mount() {
    const root = document.getElementById('panel-root');
    if (!root) return;
    const ui = (window as Window & { HarnessUI?: HarnessUI }).HarnessUI;
    if (!ui) {
      root.innerHTML = `<main class="guide"><p class="eyebrow">HARBORS HARNESS / UI</p><h1>界面规范</h1>
        <p class="notice">当前页面未加载 Kit 共享控件。请通过“视图 → 面板 → 界面规范”打开完整展示。</p></main>`;
      return;
    }
    ui.install(document);
    root.innerHTML = `<main class="guide">
      <p class="eyebrow">HARBORS HARNESS / UI</p><h1>界面规范</h1>
      <p class="intro">安静、清晰、专注。以下控件使用 Kit 提供的共享样式，保留原生交互与键盘操作。</p>
      <section><h2>颜色</h2><p>深色表面建立层次，蓝色强调主要操作与焦点；状态同时使用文字说明。</p>
        <div class="swatches"><div><i class="canvas"></i>画布</div><div><i class="surface"></i>表面</div><div><i class="raised"></i>浮层</div><div><i class="border"></i>边框</div><div><i class="accent"></i>强调</div></div></section>
      <section><h2>按钮</h2><p>主要操作突出显示，其他操作按重要性选择样式。</p>
        <div class="examples"><button type="button" class="h-button h-button--primary">主要操作</button><button type="button" class="h-button h-button--secondary">次要操作</button><button type="button" class="h-button h-button--ghost">轻操作</button><button type="button" class="h-button h-button--danger">危险操作</button><button type="button" class="h-button h-button--primary" disabled>不可用</button></div>
        <div class="examples"><harness-button>原生隔离按钮</harness-button><harness-button disabled>不可用</harness-button></div></section>
      <section><h2>列表项</h2><p>列表项可随内容增高，选中项在悬停时保持选中状态；用键盘可查看焦点。</p>
        <div class="list-examples" aria-label="列表项示例"><button type="button" class="h-list-item" aria-pressed="true">当前项目</button><button type="button" class="h-list-item" aria-pressed="false">其他项目</button><button type="button" class="h-list-item" disabled>不可用</button></div></section>
      <section><h2>输入与选择</h2><p>标签始终可见，输入与选择可通过键盘操作。</p>
        <div class="fields"><label>名称<input class="h-input" placeholder="输入名称"></label><label>类型<select class="h-select"><option>默认选项</option><option>其他选项</option></select></label><label class="field-wide">说明<textarea class="h-textarea" rows="3" placeholder="输入说明"></textarea></label><label>不可用<input class="h-input" value="不可编辑" disabled></label></div>
        <div class="choices"><label><input class="h-check" type="checkbox" checked> 接收通知</label><label><input class="h-check" type="checkbox"> 保存偏好</label><label><input class="h-check" type="checkbox" disabled> 不可用</label></div>
        <fieldset><legend>显示密度</legend><div class="choices"><label><input class="h-radio" type="radio" name="density" value="comfortable" checked> 舒适</label><label><input class="h-radio" type="radio" name="density" value="compact"> 紧凑</label></div></fieldset>
        <label class="h-switch"><input type="checkbox"><span class="h-switch__track" aria-hidden="true"></span><span>启用自动更新</span></label></section>
      <section><h2>状态与反馈</h2><p>状态配合文字说明，重要反馈应清楚描述结果。</p>
        <div class="examples"><span class="h-badge">默认</span><span class="h-badge h-badge--success">已完成</span><span class="h-badge h-badge--warning">待处理</span><span class="h-badge h-badge--danger">失败</span></div>
        <div class="feedback"><div class="h-alert">这里是一条普通提示。</div><div class="h-alert h-alert--success">设置已保存。</div><div class="h-alert h-alert--warning">请检查尚未完成的内容。</div><div class="h-alert h-alert--danger">操作失败，请重试。</div></div>
        <button type="button" class="h-button h-button--secondary" id="feedback-button">显示操作反馈</button><p id="feedback-result" role="status" aria-live="polite"></p></section>
      <section><h2>卡片与表格</h2><p>将相关信息放在一起，较窄空间允许表格横向滚动。</p>
        <div class="h-card"><strong>最近的任务</strong><p>查看当前工作状态和最近更新。</p><div class="table-wrap"><table class="h-table"><thead><tr><th scope="col">名称</th><th scope="col">状态</th><th scope="col">更新</th></tr></thead><tbody><tr><td>界面整理</td><td><span class="h-badge h-badge--success">已完成</span></td><td>今天</td></tr><tr><td>内容检查</td><td><span class="h-badge h-badge--warning">待处理</span></td><td>昨天</td></tr></tbody></table></div></div></section>
      <section><h2>空状态</h2><div class="h-card empty"><strong>暂无内容</strong><p>创建第一项内容后，它会显示在这里。</p><button type="button" class="h-button h-button--secondary" id="empty-action">了解如何开始</button><p id="empty-result" role="status" aria-live="polite"></p></div></section>
      <section><h2>文字与间距</h2><p>正文 14px，次要说明 12px；按 4、8、12、16、24、32px 的节奏留白。焦点、禁用与反馈状态不能只依赖颜色。</p></section>
    </main>`;
    root.querySelector('#feedback-button')?.addEventListener('click', () => {
      root.querySelector('#feedback-result')!.textContent = '操作已完成。';
    });
    root.querySelector('#empty-action')?.addEventListener('click', () => {
      root.querySelector('#empty-result')!.textContent = '从工作台创建内容即可开始。';
    });
    root.querySelectorAll<HTMLButtonElement>('.list-examples .h-list-item:not(:disabled)').forEach((button) => {
      button.addEventListener('click', () => {
        root.querySelectorAll('.list-examples .h-list-item[aria-pressed]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      });
    });
  },
};
