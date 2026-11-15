// tsc can't read .astro files (Astro's language tools type them); the tests
// only hand the component to the container API, so its factory type is enough.
declare module "*.astro" {
  const Component: import("astro/runtime/server/render/astro/factory.js").AstroComponentFactory;
  export default Component;
}
