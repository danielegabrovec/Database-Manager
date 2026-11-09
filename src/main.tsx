import React from "react";
import ReactDOM from "react-dom/client";
import * as monaco from "monaco-editor/editor";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/pgsql/register";
import "monaco-editor/languages/definitions/mysql/register";
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/php/register";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/csharp/register";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/go/register";
import "monaco-editor/languages/definitions/kotlin/register";
import "monaco-editor/languages/definitions/ruby/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/features/json/register";
import "monaco-editor/features/codeEditor/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/suggest/register";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/parameterHints/register";
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/comment/register";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import App from "./App";
import "./styles.css";

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    return label === "json" ? new jsonWorker() : new editorWorker();
  },
};
loader.config({ monaco: monaco as typeof import("monaco-editor") });
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
