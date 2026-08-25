import {execFileSync} from "node:child_process"
import {mkdirSync, writeFileSync} from "node:fs"
import {join} from "node:path"

const EC_CURVE = "prime256v1"
const DAYS_VALID = 365

/**
 * Generate test-only CA, server, and client certificates. Never use this
 * ephemeral material for production credentials.
 * @param {string} directory - Destination directory.
 * @param {string} [serverSubjectAltName] - Server SAN extension.
 * @returns {{caCertFile: string, serverCertFile: string, serverKeyFile: string, clientCertFile: string, clientKeyFile: string}}
 */
export function generateTlsCertificates(directory, serverSubjectAltName = "DNS:localhost, IP:127.0.0.1") {
  mkdirSync(directory, {recursive: true})
  const caKeyFile = join(directory, "ca.key")
  const caCertFile = join(directory, "ca.crt")
  const serverKeyFile = join(directory, "server.key")
  const serverCertFile = join(directory, "server.crt")
  const clientKeyFile = join(directory, "client.key")
  const clientCertFile = join(directory, "client.crt")
  const sanFile = join(directory, "server-san.ext")

  execFileSync("openssl", ["ecparam", "-genkey", "-name", EC_CURVE, "-out", caKeyFile], {stdio: "ignore"})
  execFileSync("openssl", [
    "req", "-x509", "-new", "-key", caKeyFile,
    "-out", caCertFile,
    "-days", String(DAYS_VALID),
    "-subj", "/CN=docker-quack Test CA/O=docker-quack Tests/OU=Test Only",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign"
  ], {stdio: "ignore"})
  writeFileSync(sanFile, `subjectAltName = ${serverSubjectAltName}\n`, "utf8")
  signCertificate(serverKeyFile, serverCertFile, "docker-quack-test-server", caKeyFile, caCertFile, sanFile)
  signCertificate(clientKeyFile, clientCertFile, "docker-quack-test-client", caKeyFile, caCertFile)

  return {caCertFile, serverCertFile, serverKeyFile, clientCertFile, clientKeyFile}
}

/**
 * @param {string} keyFile - Output key.
 * @param {string} certFile - Output certificate.
 * @param {string} commonName - Certificate common name.
 * @param {string} caKeyFile - Signing CA key.
 * @param {string} caCertFile - Signing CA certificate.
 * @param {string} [extensionFile] - Optional certificate extensions.
 * @returns {void}
 */
function signCertificate(keyFile, certFile, commonName, caKeyFile, caCertFile, extensionFile) {
  execFileSync("openssl", ["ecparam", "-genkey", "-name", EC_CURVE, "-out", keyFile], {stdio: "ignore"})
  const requestFile = certFile.replace(/\.crt$/, ".csr")
  execFileSync("openssl", [
    "req", "-new", "-key", keyFile,
    "-subj", `/CN=${commonName}/O=docker-quack Tests/OU=Test Only`,
    "-out", requestFile
  ], {stdio: "ignore"})
  const args = [
    "x509", "-req", "-in", requestFile,
    "-CA", caCertFile, "-CAkey", caKeyFile, "-CAcreateserial",
    "-out", certFile, "-days", String(DAYS_VALID)
  ]
  if (extensionFile !== undefined) args.push("-extfile", extensionFile)
  execFileSync("openssl", args, {stdio: "ignore"})
}
