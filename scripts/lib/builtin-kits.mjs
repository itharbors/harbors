export const BUILTIN_KITS = Object.freeze([
  Object.freeze({ slug: 'default', id: '@itharbors/kit-default' }),
]);

export const BUILTIN_KIT_IDS = Object.freeze(BUILTIN_KITS.map((kit) => kit.id));
