declare module '*.module.css' {
  const classes: { [key: string]: string }
  export default classes
}

declare module '*.module.scss' {
  const classes: { [key: string]: string }
  export default classes
}

declare module '*.css' {
  const content: string
  export default content
}

declare module '*.png' {
  const url: string
  export default url
}
