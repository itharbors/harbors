let runtime: any = null;
let dispose: (() => void) | null = null;

function handleChange(event: any) {
  if (!runtime) {
    return;
  }

  runtime.message.broadcast('config.changed', {
    ...event,
    value: runtime.config.get(event.key, event.type),
    resolvedValue: runtime.config.get(event.key),
  });
}

export function load(editorRuntime: any) {
  runtime = editorRuntime;
  dispose = editorRuntime.config.subscribe(handleChange);
}

export function unload() {
  dispose?.();
  dispose = null;
  runtime = null;
}

declare const editor: any;

if (typeof editor !== 'undefined' && editor?.plugin?.define) {
  editor.plugin.define({
    lifecycle: {
      load,
      unload,
    },
    methods: {},
  });
}
