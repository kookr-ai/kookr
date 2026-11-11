// Vite turns `import url from './file.glb?url'` into the URL of the emitted asset.
declare module '*.glb?url' {
  const url: string;
  export default url;
}
