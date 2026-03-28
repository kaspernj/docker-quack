import jsdoc from "eslint-plugin-jsdoc"

export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module"
    },
    plugins: {
      jsdoc
    }
  }
]
