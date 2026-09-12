"""Change only an isolated native smoke window's input layout (no global input)."""
import ctypes as c
from ctypes import wintypes as w
import json
import sys
import time

pid = int(sys.argv[1])
requested = sys.argv[2]
u = c.WinDLL('user32', use_last_error=True)
u.GetForegroundWindow.restype = w.HWND
u.GetWindowThreadProcessId.argtypes = [w.HWND, c.POINTER(w.DWORD)]
u.GetWindowThreadProcessId.restype = w.DWORD
u.SetForegroundWindow.argtypes = [w.HWND]
u.IsWindowVisible.argtypes = [w.HWND]
u.GetKeyboardLayout.argtypes = [w.DWORD]
u.GetKeyboardLayout.restype = w.HANDLE
u.GetKeyboardLayoutList.argtypes = [c.c_int, c.POINTER(w.HANDLE)]
u.PostMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
class GUI(c.Structure):
    _fields_ = [('cbSize', w.DWORD), ('flags', w.DWORD),
                ('hwndActive', w.HWND), ('hwndFocus', w.HWND),
                ('hwndCapture', w.HWND), ('hwndMenuOwner', w.HWND),
                ('hwndMoveSize', w.HWND), ('hwndCaret', w.HWND), ('rcCaret', w.RECT)]
u.GetGUIThreadInfo.argtypes = [w.DWORD, c.POINTER(GUI)]
windows = []
callback_type = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
@callback_type
def collect(hwnd, _):
    owner = w.DWORD()
    u.GetWindowThreadProcessId(hwnd, c.byref(owner))
    if owner.value == pid and u.IsWindowVisible(hwnd):
        windows.append(hwnd)
    return True
u.EnumWindows(collect, 0)
if not windows:
    raise RuntimeError('Isolated test window not found')
hwnd = windows[0]
u.SetForegroundWindow(hwnd)
time.sleep(0.05)
if u.GetForegroundWindow() != hwnd:
    raise RuntimeError('Test window did not receive foreground focus')
info = GUI(cbSize=c.sizeof(GUI))
if not u.GetGUIThreadInfo(0, c.byref(info)) or not info.hwndFocus:
    raise RuntimeError('No focused input window')
thread = u.GetWindowThreadProcessId(info.hwndFocus, None)
count = u.GetKeyboardLayoutList(0, None)
layouts = (w.HANDLE * count)()
u.GetKeyboardLayoutList(count, layouts)
target = next((h for h in layouts if h & 0xffffffff == int(requested, 16)), None)
if not target:
    raise RuntimeError('Requested layout is not installed: ' + requested)
requested_at = round(time.time() * 1000)
if not u.PostMessageW(info.hwndFocus, 0x50, 0, target):
    raise RuntimeError('Cannot request test layout')
deadline = time.monotonic() + 3
while time.monotonic() < deadline:
    actual = u.GetKeyboardLayout(thread) & 0xffffffff
    if actual == target & 0xffffffff:
        print(json.dumps({'requestedAt': requested_at, 'layout': f'{actual:08X}'}))
        break
    time.sleep(0.01)
else:
    raise RuntimeError('Input window did not switch layout')
