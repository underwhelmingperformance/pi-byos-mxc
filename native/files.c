#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int failure(void) {
  if (errno == ENOENT || errno == ENOTDIR)
    return 44;
  if (errno == EPERM || errno == EACCES || errno == EROFS)
    return 43;
  return 1;
}

static const char *kind(mode_t mode) {
  if (S_ISREG(mode))
    return "file";
  if (S_ISDIR(mode))
    return "directory";
  if (S_ISLNK(mode))
    return "symlink";
  return "other";
}

static int list(const char *path) {
  DIR *dir = opendir(path);
  if (!dir)
    return failure();
  struct dirent *entry;
  for (;;) {
    errno = 0;
    entry = readdir(dir);
    if (!entry)
      break;
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
      continue;
    struct stat st;
    if (fstatat(dirfd(dir), entry->d_name, &st, AT_SYMLINK_NOFOLLOW))
      return failure();
    if (printf("%s%c%s%c", kind(st.st_mode), 0, entry->d_name, 0) < 0)
      return 1;
  }
  if (errno)
    return failure();
  return closedir(dir) || fflush(stdout) ? 1 : 0;
}

static int make_directory(char *path) {
  for (char *p = path + 1;; p++) {
    if (*p != '/' && *p != '\0')
      continue;
    char delimiter = *p;
    *p = '\0';
    struct stat existing;
    if (stat(path, &existing) || !S_ISDIR(existing.st_mode)) {
      if (mkdir(path, 0777)) {
        if (errno != EEXIST)
          return failure();
        struct stat st;
        if (stat(path, &st))
          return failure();
        if (!S_ISDIR(st.st_mode))
          return 1;
      }
    }
    *p = delimiter;
    if (!delimiter)
      return 0;
  }
}

static int copy(FILE *from, FILE *to, uintmax_t *total) {
  unsigned char buffer[65536];
  size_t size;
  while ((size = fread(buffer, 1, sizeof(buffer), from)) > 0) {
    *total += size;
    if (fwrite(buffer, 1, size, to) != size)
      return failure();
  }
  return ferror(from) || fflush(to) ? failure() : 0;
}

int main(int argc, char **argv) {
  if ((argc != 3 && argc != 4) || argv[2][0] != '/')
    return 1;
  const char *op = argv[1], *path = argv[2];
  if (!strcmp(op, "stat")) {
    struct stat st;
    if (stat(path, &st))
      return failure();
    printf("%s %" PRIdMAX, kind(st.st_mode), (intmax_t)st.st_size);
    return fflush(stdout) ? 1 : 0;
  }
  if (!strcmp(op, "listDirectory"))
    return list(path);
  if (!strcmp(op, "mkdir"))
    return make_directory(argv[2]);
  if (!strcmp(op, "readAccess") || !strcmp(op, "writeAccess"))
    return access(path, !strcmp(op, "readAccess") ? R_OK : W_OK) ? failure()
                                                                 : 0;
  if (!strcmp(op, "readFile") || !strcmp(op, "writeFile")) {
    int writing = !strcmp(op, "writeFile");
    FILE *file = fopen(path, writing ? "wb" : "rb");
    if (!file)
      return failure();
    uintmax_t total = 0;
    int result =
        writing ? copy(stdin, file, &total) : copy(file, stdout, &total);
    if (writing && (argc != 4 || total != strtoumax(argv[3], NULL, 10)))
      result = 1;
    return fclose(file) && !result ? failure() : result;
  }
  return 1;
}
