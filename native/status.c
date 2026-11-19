#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/event.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2)
    return EXIT_FAILURE;
  char *end;
  long pid = strtol(argv[1], &end, 10);
  if (*end || pid <= 0 || pid > INT_MAX)
    return EXIT_FAILURE;

  int queue = kqueue();
  struct kevent subscriptions[2], event;
  EV_SET(&subscriptions[0], pid, EVFILT_PROC, EV_ADD | EV_ONESHOT,
         NOTE_EXIT | NOTE_EXITSTATUS, 0, NULL);
  EV_SET(&subscriptions[1], STDIN_FILENO, EVFILT_READ, EV_ADD, 0, 0, NULL);
  if (queue < 0 || kevent(queue, subscriptions, 2, NULL, 0, NULL) < 0)
    return EXIT_FAILURE;
  if (puts("ready") < 0 || fflush(stdout))
    return EXIT_FAILURE;

  int count;
  do {
    count = kevent(queue, NULL, 0, &event, 1, NULL);
  } while (count < 0 && errno == EINTR);
  if (count != 1 || event.filter != EVFILT_PROC || (event.flags & EV_ERROR) ||
      !(event.fflags & NOTE_EXITSTATUS))
    return EXIT_FAILURE;
  int status = (int)event.data;
  if (WIFEXITED(status))
    printf("%d\n", WEXITSTATUS(status));
  else if (WIFSIGNALED(status))
    printf("-%d\n", WTERMSIG(status));
  else
    return EXIT_FAILURE;
  return EXIT_SUCCESS;
}
