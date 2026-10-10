# afm-4th — Claude Code 전용 규칙

저장소 공통 규칙(소통, 디렉터리, 앱 구조, 비밀값, 문서화, Git)은 모든 AI 에이전트가 함께 쓰도록
[AGENTS.md](AGENTS.md)에 있습니다. 아래 줄이 그 파일을 불러옵니다.

@AGENTS.md

이 파일에는 Claude Code에만 해당하는 내용만 둡니다.

## 에이전트 메모리

- 저장소에 공유할 맥락 → `docs/agent-memory/` (AGENTS.md에서 링크)
- 개인용·기기별 메모리 → `~/.claude/projects/<프로젝트>/memory/` (git 제외)

`.gitignore`가 `.claude/` 전체를 제외하므로, 공유할 규칙을 `.claude/` 안에 두면 커밋되지 않습니다.

## 커스텀 에이전트·스킬

`.claude/agents/`(class-tutor, secretary, single-react-dev, single-server-specialist)와
`.claude/skills/`는 이 기기에만 있습니다. 다른 기기에서는 없을 수 있으니 의존하는 규칙은
AGENTS.md나 `docs/agent-memory/`에 적습니다.
