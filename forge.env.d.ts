declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

declare module "*?raw" {
  const content: string
  export default content
}
declare module "*.md?raw" {
  const content: string
  export default content
}
