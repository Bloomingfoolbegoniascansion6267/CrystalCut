# CrystalCut 다국어 지원 구현 계획

> 작성일: 2026-08-23
> 상태: 구현 기준 문서

## 1. 목표

CrystalCut은 최초 실행 시 운영체제 언어를 감지해 지원되는 언어로 표시하고, 사용자가 `설정 > 일반 > 언어`에서 시스템 언어 또는 특정 언어를 선택할 수 있어야 한다.

번역은 한국어 문장의 어순과 길이를 그대로 옮기지 않는다. 각 문구의 화면 위치, 역할, 사용자 의도와 길이 제약을 정의하고, 해당 국가의 이미지 편집 소프트웨어에서 실제로 사용할 법한 간결한 제품 문구로 작성한다.

## 2. 1차 지원 언어

- 한국어 (`ko`)
- 영어 (`en`)
- 일본어 (`ja`)
- 중국어 간체 (`zh-CN`)
- 중국어 번체 (`zh-TW`)
- 스페인어 (`es`)
- 독일어 (`de`)
- 프랑스어 (`fr`)
- 포르투갈어(브라질, `pt-BR`)

CrystalCut, PNG, WebP, EXIF, SAM, px와 사용자가 만든 파일명·프리셋명·파일명 템플릿 토큰은 번역하지 않는다.

## 3. 언어 결정 규칙

환경설정에는 실제 해석된 언어가 아니라 사용자의 선택만 저장한다.

```ts
type LanguagePreference = "system" | SupportedLocale;
```

해석 순서는 다음과 같다.

1. 사용자가 명시적으로 선택한 지원 언어
2. `system`이면 Tauri OS 플러그인이 반환한 BCP-47 시스템 로캘
3. 시스템 로캘을 얻지 못하면 `navigator.languages`
4. 정확한 로캘, 문자 체계, 기본 언어 순으로 가장 가까운 카탈로그 탐색
5. 지원되는 카탈로그가 없으면 영어로 대체

`zh-Hans`는 `zh-CN`, `zh-Hant`는 `zh-TW`로 해석한다. 메시지 카탈로그 언어와 날짜·숫자 표기에 사용할 지역 로캘을 분리하여, 예를 들어 `en-GB` 환경은 영어 메시지와 영국식 숫자·날짜 형식을 함께 사용한다.

## 4. 설정 화면 동작

`설정 > 일반`의 첫 카드에 언어 선택기를 추가한다.

- 기본값: `시스템 설정 사용 — 한국어`처럼 현재 해석 결과를 함께 표시
- 언어를 선택하면 앱 전체에 즉시 미리보기 적용
- 저장하면 환경설정에 기록
- 취소하면 설정 창을 열기 전 언어로 복귀
- `시스템 설정 사용`으로 돌아가면 시스템 로캘을 다시 확인
- 재시작 없이 적용하되 실행 중 운영체제 언어가 변경된 경우 다음 실행에서 반영

기존 환경설정 JSON에는 역직렬화 기본값이 `system`인 `language` 필드를 추가한다. 따라서 데이터베이스 스키마 마이그레이션 없이 기존 설치와 호환한다.

운영체제가 제공하는 네이티브 파일·폴더 선택 창은 앱에서 선택한 언어가 아니라 운영체제 언어를 따를 수 있다.

## 5. 메시지 구조

메시지는 기능과 문맥을 나타내는 안정적인 ID를 사용한다.

```text
settings.language.title
settings.language.system
output.resize.mode.longEdge
batch.action.removeAndSave
editor.selection.refine
error.model.downloadFailed
```

같은 한국어 단어라도 역할이 다르면 `toast.dismiss`, `dialog.cancel`, `editor.finish`처럼 분리한다. 번역 문장을 조각내어 연결하지 않고 변수와 복수형을 포함하는 완전한 메시지 단위로 작성한다.

카탈로그는 다음 구조로 관리한다.

```text
src/i18n/
  I18nProvider.tsx
  locale.ts
  messages/
    ko.ts
    en.ts
    ja.ts
    zh-CN.ts
    zh-TW.ts
    es.ts
    de.ts
    fr.ts
    pt-BR.ts
```

## 6. 번역 작성 원칙

- 버튼은 동작 중심으로 짧게 쓴다.
- 주변 화면에서 이미 알 수 있는 명사는 반복하지 않는다.
- 긴 설명은 레이블에 넣지 않고 보조 설명이나 툴팁으로 분리한다.
- 원문의 단어가 아니라 기능의 실제 의미를 번역한다.
- 각 메시지에는 화면 위치, 컨트롤 역할, 의도, 변수, 권장 길이를 설명한다.
- 각 언어의 이미지 편집 소프트웨어에서 널리 쓰이는 용어를 우선한다.
- 숫자, 날짜, 시간, 용량, 백분율과 개수는 `Intl`로 표시한다.

예:

| 기능 | 영어 | 한국어 |
| --- | --- | --- |
| 원본 크기 유지 | Original size | 원본 크기 |
| 작은 이미지 확대 방지 | Don’t upscale | 확대하지 않기 |
| 선택 영역 보정 | Refine selection | 선택 영역 다듬기 |
| 가장자리 부드럽게 | Smooth edges | 가장자리 다듬기 |
| 제거 후 저장 | Remove & save | 배경 제거 후 저장 |
| 메타데이터 보존 | Keep photo metadata | 촬영 정보 유지 |

## 7. Rust 오류와 상태 현지화

Rust가 완성된 한국어 오류 문장을 반환하지 않도록 오류를 `{ code, params, detail }` 구조로 점진적으로 변경한다. 사용자 문구는 프론트엔드가 `code`를 현지화하고, 원인 문자열과 로그는 진단 정보로 분리한다.

```json
{
  "code": "output.invalidWebpQuality",
  "params": { "min": 1, "max": 100 },
  "detail": "encoder rejected quality value"
}
```

배치 상태, 내보내기 경고, 모델 상태도 저장·통신 값은 번역하지 않고 화면에 표시할 때만 번역한다.

## 8. 레이아웃과 접근성

- 고정 너비 컨트롤을 최소화하고 긴 언어에서 자연스럽게 확장 또는 줄바꿈한다.
- 900×640, 1320×820 창과 Windows 100%·125%·150% 배율을 검증한다.
- 일본어·중국어 줄바꿈과 독일어의 30~40% 길이 증가를 확인한다.
- `aria-label`, 툴팁, 빈 상태, 토스트도 모두 현지화한다.
- 선택 언어에 맞게 문서 `lang`, `dir`, 창 제목을 갱신한다.
- 향후 RTL 언어를 위해 방향 전환 구조를 유지한다.

## 9. 자동 검증

- 모든 카탈로그의 누락 키와 불필요한 키 검사
- 메시지 변수 일치 여부 검사
- 사용자 화면에 새로 추가된 한국어 하드코딩 검사
- 주요 언어·창 크기별 스크린샷 검증
- 긴 문구로 구성된 의사 로캘과 RTL 의사 로캘 검증
- 최초 시스템 언어 감지, 명시적 선택 저장, `system` 복귀, 미지원 언어 대체 테스트

## 10. 구현 순서

1. 문서 번호와 링크 정리
2. 로캘 해석기, 메시지 공급자와 포맷 함수 구현
3. 환경설정 모델과 설정 화면 언어 옵션 구현
4. 공통 메뉴·버튼·설정 화면 문구 이전
5. 작업 목록·출력 설정·미리보기 편집 화면 문구 이전
6. 토스트·경고·빈 화면·접근성 문구 이전
7. Rust 오류·경고를 구조화된 코드로 점진 전환
8. 모든 지원 언어 카탈로그 작성
9. 누락 키와 레이아웃 자동 검증 추가
10. Windows 및 macOS에서 시스템 언어와 명시적 선택 동작 검증

## 11. 완료 기준

- 최초 실행에서 지원되는 시스템 언어가 깜박임 없이 적용된다.
- 설정에서 언어를 즉시 바꾸고 저장하거나 취소할 수 있다.
- 미지원 로캘과 누락 메시지는 영어로 안전하게 대체된다.
- 숫자·날짜·용량·개수가 현재 로캘 규칙을 따른다.
- 모든 주요 화면, 메뉴, 툴팁, 접근성 이름과 사용자 오류가 현지화된다.
- 어느 지원 언어에서도 버튼 잘림이나 불필요한 가로 스크롤이 발생하지 않는다.
- 번역은 원문 직역이 아니라 각 언어의 제품 문맥과 컨트롤 길이에 맞게 검수된다.

## 참고 자료

- Tauri OS locale: https://v2.tauri.app/reference/javascript/os/
- Tauri OS plugin: https://v2.tauri.app/plugin/os-info/
- React Intl: https://formatjs.github.io/docs/react-intl/
- FormatJS CLI: https://formatjs.github.io/docs/tooling/cli/
- MDN `navigator.languages`: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/languages
- MDN Internationalization: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Internationalization
