#include <windows.h>
#include <stdio.h>
int main(void) {
  DWORD pids[1];
  printf("{\"mode\":%lu,\"console\":%lu,\"visible\":%d}\n",
    GetErrorMode(), GetConsoleProcessList(pids, 1), IsWindowVisible(GetConsoleWindow()));
  return 0;
}
