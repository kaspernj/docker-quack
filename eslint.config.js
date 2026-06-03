import js from "@eslint/js"
import {jsdoc} from "eslint-plugin-jsdoc"
import globals from "globals"
import {defineConfig} from "eslint/config"

export default defineConfig([
  {
    name: "global ignores",
    ignores: ["build/**"]
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: {js},
    extends: ["js/recommended"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module"
    },
    rules: {
      "comma-dangle": ["error", "never"],
      "no-unused-vars": ["error", {argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_"}],
      "object-curly-spacing": ["error", "never"],
      semi: ["error", "never"]
    }
  },
  jsdoc({
    config: "flat/recommended",
    files: ["src/**/*.js"],
    settings: {
      jsdoc: {
        definedTypes: ["AsyncIterable"]
      }
    },
    rules: {
      "jsdoc/no-undefined-types": "off",
      "jsdoc/reject-any-type": "error",
      "jsdoc/require-param-description": "off",
      "jsdoc/require-returns-description": "off"
    }
  }),
  {
    files: ["spec/**/*.js"],
    rules: {
      "no-undef": "off"
    }
  }
])
