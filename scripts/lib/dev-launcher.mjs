export function createDevServerEnv(baseEnv, requestedKit) {
  const serverEnv = { ...baseEnv };
  delete serverEnv.CE_DEFAULT_KIT;
  delete serverEnv.CE_KIT_MODE;
  if (requestedKit) serverEnv.CE_DEFAULT_KIT = requestedKit;
  return serverEnv;
}

export function createDevPages(requestedKit) {
  return [
    ['Kit chooser', '/'],
    ...(requestedKit ? [['Requested Kit', `/?kit=${encodeURIComponent(requestedKit)}`]] : []),
    ['Layout Kit', '/?page=layout-kit'],
    ['UI Kit', '/?page=ui-kit'],
  ];
}
