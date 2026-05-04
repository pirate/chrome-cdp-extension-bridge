from __future__ import annotations

from collections.abc import Callable, Mapping
from queue import Queue
from typing import Literal, Protocol, TypeAlias, TypedDict

JsonPrimitive: TypeAlias = None | bool | int | float | str
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

ProtocolParams: TypeAlias = Mapping[str, JsonValue]
ProtocolResult: TypeAlias = dict[str, JsonValue]
ProtocolPayload: TypeAlias = dict[str, JsonValue]
FrameParams: TypeAlias = Mapping[str, object]
ModCDPRoutes: TypeAlias = dict[str, str]


class _ModCDPAddCustomCommandRequired(TypedDict):
    name: str
    expression: str


class ModCDPAddCustomCommandParams(_ModCDPAddCustomCommandRequired, total=False):
    paramsSchema: JsonValue
    resultSchema: JsonValue


class _ModCDPAddCustomEventObjectRequired(TypedDict):
    name: str


class ModCDPAddCustomEventObjectParams(_ModCDPAddCustomEventObjectRequired, total=False):
    eventSchema: JsonValue


ModCDPAddCustomEventParams: TypeAlias = str | ModCDPAddCustomEventObjectParams


class _ModCDPAddMiddlewareRequired(TypedDict):
    phase: Literal["request", "response", "event"]
    expression: str


class ModCDPAddMiddlewareParams(_ModCDPAddMiddlewareRequired, total=False):
    name: str


class ModCDPPingLatency(TypedDict):
    sentAt: int
    receivedAt: int | float | None
    returnedAt: int
    roundTripMs: int
    serviceWorkerMs: int | float | None
    returnPathMs: int | float | None


class ModCDPConnectTiming(TypedDict):
    started_at: int
    extension_source: str | None
    extension_started_at: int
    extension_completed_at: int
    extension_duration_ms: int
    connected_at: int
    duration_ms: int


class ModCDPCommandTiming(TypedDict):
    method: str
    target: str
    started_at: int
    completed_at: int
    duration_ms: int


class ModCDPRawTiming(TypedDict):
    method: str
    started_at: int
    completed_at: int
    duration_ms: int


class ModCDPServerConfig(TypedDict, total=False):
    loopback_cdp_url: str | None
    routes: ModCDPRoutes
    browserToken: str | None
    custom_commands: list[ModCDPAddCustomCommandParams]
    custom_events: list[ModCDPAddCustomEventObjectParams]
    custom_middlewares: list[ModCDPAddMiddlewareParams]


class LaunchOptions(TypedDict, total=False):
    executable_path: str
    port: int
    headless: bool
    sandbox: bool
    extra_args: list[str]


RuntimeEvaluateParams: TypeAlias = dict[str, JsonValue]


class _TranslatedStepRequired(TypedDict):
    method: str


class TranslatedStep(_TranslatedStepRequired, total=False):
    params: FrameParams
    unwrap: Literal["evaluate"]


class TranslatedCommand(TypedDict):
    route: str
    target: Literal["direct_cdp", "service_worker"]
    steps: list[TranslatedStep]


class CdpError(TypedDict, total=False):
    message: str


class CdpFrame(TypedDict, total=False):
    id: int
    method: str
    params: FrameParams
    sessionId: str
    result: ProtocolResult
    error: CdpError


class TargetInfo(TypedDict):
    targetId: str
    type: str
    url: str


class ExtensionProbe(TypedDict):
    extension_id: str
    target_id: str
    url: str
    session_id: str


class ExtensionInfo(ExtensionProbe):
    source: str


class BorrowedExtensionInfo(ExtensionInfo, total=False):
    has_tabs: bool
    has_debugger: bool


class UnwrappedModCDPEvent(TypedDict):
    event: str
    data: ProtocolPayload
    sessionId: str | None


Handler: TypeAlias = Callable[[ProtocolPayload], None]
PendingEntry: TypeAlias = tuple[str, Queue[CdpFrame]]


class WebSocketLike(Protocol):
    def send(self, payload: str) -> object: ...

    def recv(self) -> str | bytes | None: ...

    def close(self) -> object: ...
