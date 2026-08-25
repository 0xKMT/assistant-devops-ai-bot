# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim AS friday-build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY core ./core
COPY integrations ./integrations
COPY types ./types
RUN npm ci \
    && npm run build --workspace @friday/git-adapter \
    && npm run build --workspace @friday/jira-adapter \
    && npm run build --workspace @friday/security-shield

FROM ghcr.io/openclaw/openclaw:2026.7.1-2@sha256:8789721d2e9b24b780a1504b56deb4c6bd5c7dbf96a1dd117e7c45c2ed72c8ac

ARG TARGETARCH
ARG TFLINT_VERSION=0.64.0
ARG TRIVY_VERSION=0.70.0
ARG HELM_VERSION=4.1.3
ARG KUSTOMIZE_VERSION=5.8.1
ARG KUBECONFORM_VERSION=0.8.0
ARG GH_VERSION=2.97.0
ARG CODEX_VERSION=0.147.0
ARG CLAUDE_CODE_VERSION=2.1.226

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq openssh-client tar unzip \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) \
        tflint_sha='cca9d13e2e1d7a2c627af60ff899a3c9b74212899416aeb96ec764d2ef954537'; \
        trivy_arch='64bit'; trivy_sha='8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9'; \
        helm_sha='02ce9722d541238f81459938b84cf47df2fdf1187493b4bfb2346754d82a4700'; \
        kustomize_sha='029a7f0f4e1932c52a0476cf02a0fd855c0bb85694b82c338fc648dcb53a819d'; \
        kubeconform_sha='9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883'; \
        gh_sha='a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112' ;; \
      arm64) \
        tflint_sha='560da89aacf59389d4eb029730dd5b109b7288096c32f2726a0d9e783a5ea8eb'; \
        trivy_arch='ARM64'; trivy_sha='2f6bb988b553a1bbac6bdd1ce890f5e412439564e17522b88a4541b4f364fc8d'; \
        helm_sha='5db45e027cc8de4677ec869e5d803fc7631b0bab1c1eb62ac603a62d22359a43'; \
        kustomize_sha='0953ea3e476f66d6ddfcd911d750f5167b9365aa9491b2326398e289fef2c142'; \
        kubeconform_sha='1f53fc8e81258197a35e8603054162a5af1de8c5af13746c71ab680d9534ed87'; \
        gh_sha='73ea440ecad9c9e284429997ee6f93577bc6f7bc6fba357ef62c53ad8fb641a5' ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /tmp/friday-tools; cd /tmp/friday-tools; \
    curl -fsSLo tflint.zip "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/tflint_linux_${TARGETARCH}.zip"; \
    echo "${tflint_sha}  tflint.zip" | sha256sum -c -; unzip -q tflint.zip -d /usr/local/bin; \
    curl -fsSLo trivy.tgz "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${trivy_arch}.tar.gz"; \
    echo "${trivy_sha}  trivy.tgz" | sha256sum -c -; tar -xzf trivy.tgz -C /usr/local/bin trivy; \
    curl -fsSLo helm.tgz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz"; \
    echo "${helm_sha}  helm.tgz" | sha256sum -c -; tar -xzf helm.tgz; mv "linux-${TARGETARCH}/helm" /usr/local/bin/helm; \
    curl -fsSLo kustomize.tgz "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${KUSTOMIZE_VERSION}/kustomize_v${KUSTOMIZE_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    echo "${kustomize_sha}  kustomize.tgz" | sha256sum -c -; tar -xzf kustomize.tgz -C /usr/local/bin kustomize; \
    curl -fsSLo kubeconform.tgz "https://github.com/yannh/kubeconform/releases/download/v${KUBECONFORM_VERSION}/kubeconform-linux-${TARGETARCH}.tar.gz"; \
    echo "${kubeconform_sha}  kubeconform.tgz" | sha256sum -c -; tar -xzf kubeconform.tgz -C /usr/local/bin kubeconform; \
    curl -fsSLo gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    echo "${gh_sha}  gh.tgz" | sha256sum -c -; tar -xzf gh.tgz; mv "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh; \
    chmod 0755 /usr/local/bin/tflint /usr/local/bin/trivy /usr/local/bin/helm /usr/local/bin/kustomize /usr/local/bin/kubeconform /usr/local/bin/gh; \
    rm -rf /tmp/friday-tools

RUN npm install --global --omit=dev \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

COPY compat/slack /opt/friday/source/compat/slack
COPY scripts/slack-compat.mjs /opt/friday/source/scripts/slack-compat.mjs
RUN HOME=/tmp/friday-plugin-home OPENCLAW_STATE_DIR=/tmp/friday-plugin-state \
      openclaw plugins install "npm:@openclaw/slack@2026.7.1" \
    && mkdir -p /opt/friday/plugins \
    && slack_project="$(find /tmp/friday-plugin-state/npm/projects -mindepth 1 -maxdepth 1 -type d | head -n 1)" \
    && test -n "$slack_project" \
    && cp -a "$slack_project" /opt/friday/plugins/slack-project \
    && node /opt/friday/source/scripts/slack-compat.mjs \
      --plugin-root /opt/friday/plugins/slack-project/node_modules/@openclaw/slack \
      --no-backup \
      --apply \
    && rm -rf /tmp/friday-plugin-home /tmp/friday-plugin-state

COPY . /opt/friday/source
COPY --from=friday-build /src/integrations/git-adapter/dist /opt/friday/source/integrations/git-adapter/dist
COPY --from=friday-build /src/integrations/jira-adapter/dist /opt/friday/source/integrations/jira-adapter/dist
COPY --from=friday-build /src/core/security-shield/dist /opt/friday/source/core/security-shield/dist
COPY container/entrypoint.sh /opt/friday/bin/entrypoint
RUN chmod 0755 /opt/friday/bin/entrypoint \
    && chown -R root:root /opt/friday \
    && chmod -R a-w /opt/friday

ENV HOME=/home/node \
    OPENCLAW_STATE_DIR=/home/node/.openclaw \
    PATH=/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin

USER node
WORKDIR /app
ENTRYPOINT ["/opt/friday/bin/entrypoint"]
CMD ["node", "/app/openclaw.mjs", "gateway"]

LABEL org.opencontainers.image.title="Friday DevOps AI Agent" \
      org.opencontainers.image.description="Owner-only read-only infrastructure PR reviewer on OpenClaw" \
      ai.friday.openclaw.version="2026.7.1-2"
