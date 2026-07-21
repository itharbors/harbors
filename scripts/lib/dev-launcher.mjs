export function createDevServerEnv(baseEnv, defaultKit) {
  const serverEnv = { ...baseEnv };
  delete serverEnv.CE_DEFAULT_KIT;
  serverEnv.CE_KIT_MODE = defaultKit ? 'single' : 'multi';
  if (defaultKit) serverEnv.CE_DEFAULT_KIT = defaultKit;
  return serverEnv;
}

export function createDevPages(mode) {
  return [
    [mode === 'single' ? 'Editor' : 'Kit chooser', '/'],
    ['Layout Kit', '/?page=layout-kit'],
    ['UI Kit', '/?page=ui-kit'],
  ];
}
