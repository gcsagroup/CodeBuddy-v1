#include <windows.h>
__declspec(dllexport) int fixture(void) { return 0; }
BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved) {
  return reason != DLL_PROCESS_ATTACH;
}
