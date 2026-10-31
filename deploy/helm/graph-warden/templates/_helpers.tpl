{{- define "gw.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "gw.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "gw.labels" -}}
app.kubernetes.io/name: {{ include "gw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "gw.selector" -}}
app.kubernetes.io/name: {{ include "gw.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "gw.image" -}}
{{- if not .Values.image.repository -}}
{{- fail "image.repository is required: the image built from the repository's Dockerfile" -}}
{{- end -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "gw.serviceAccount" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "gw.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Settings shared by the API and the worker: Neo4j and the ontology. */}}
{{- define "gw.commonEnv" -}}
- name: NEO4J_URI
  value: {{ required "neo4j.uri is required" .Values.neo4j.uri | quote }}
- name: NEO4J_USER
  value: {{ .Values.neo4j.user | quote }}
- name: NEO4J_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.neo4j.passwordSecret.name }}
      key: {{ .Values.neo4j.passwordSecret.key }}
{{- if .Values.ontology }}
- name: GWARDEN_ONTOLOGY
  value: /etc/gwarden/ontology.yaml
{{- end }}
{{- end -}}

{{- define "gw.env" -}}
{{- range $name, $value := .env }}
- name: {{ $name }}
  value: {{ $value | toString | quote }}
{{- end }}
{{- range $name, $ref := .secretEnv }}
- name: {{ $name }}
  valueFrom:
    secretKeyRef:
      name: {{ $ref.secret }}
      key: {{ $ref.key }}
{{- end }}
{{- end -}}
