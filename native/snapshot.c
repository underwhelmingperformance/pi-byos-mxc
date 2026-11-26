#include <dirent.h>
#include <err.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/clonefile.h>
#include <sys/stat.h>
#include <unistd.h>

struct entry {
  char *name;
  struct stat metadata;
  struct entry *children;
  struct entry *next;
};

static size_t entries;
static uint64_t bytes;

enum snapshot_refusal {
  ENTRY_LIMIT = 2,
  DEPTH_LIMIT,
  BYTE_LIMIT,
  ABSOLUTE_LINK,
  UNRESOLVED_LINK,
  CROSSES_MOUNT,
  RESTRICTED_FLAGS,
  SPECIAL_FILE,
  HARD_LINK,
  SOURCE_CHANGED,
  PATH_LIMIT,
  CLONE_UNAVAILABLE,
};

static int unchanged(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
         a->st_mode == b->st_mode && a->st_nlink == b->st_nlink &&
         a->st_size == b->st_size &&
         a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec &&
         a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec &&
         a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec &&
         a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec;
}

static struct entry *copy_entry(int source, int target, const char *name,
                                const char *output, unsigned depth,
                                dev_t volume) {
  if (++entries > 100000)
    errx(ENTRY_LIMIT, "Workspace exceeds the snapshot entry limit");
  if (depth > 128)
    errx(DEPTH_LIMIT, "Workspace exceeds the snapshot depth limit");

  struct entry *item = calloc(1, sizeof(*item));
  if (!item || !(item->name = strdup(name)))
    err(1, "allocate snapshot manifest");
  struct stat *st = &item->metadata;
  if (fstatat(source, name, st, AT_SYMLINK_NOFOLLOW))
    err(1, "inspect snapshot source");
  if (st->st_dev != volume)
    errx(CROSSES_MOUNT, "Snapshot source crosses a mount");

  if (st->st_flags & (UF_IMMUTABLE | UF_APPEND | SF_IMMUTABLE | SF_APPEND))
    errx(RESTRICTED_FLAGS, "Snapshot contains an immutable or append-only entry");

  if (S_ISLNK(st->st_mode)) {
    char link[PATH_MAX];
    ssize_t size = readlinkat(source, name, link, sizeof(link));
    if (size < 0)
      err(1, "Read snapshot link");
    if ((size_t)size >= sizeof(link))
      errx(PATH_LIMIT, "Snapshot link exceeds the path length limit");
    link[size] = 0;
    if (link[0] == '/')
      errx(ABSOLUTE_LINK, "Snapshot contains an absolute symbolic link");
    if (symlinkat(link, target, output))
      err(1, "copy snapshot link");
    return item;
  }

  if (!S_ISDIR(st->st_mode) && !S_ISREG(st->st_mode))
    errx(SPECIAL_FILE, "Snapshot contains a special file");
  if (S_ISREG(st->st_mode) && st->st_nlink != 1)
    errx(HARD_LINK, "Snapshot contains a multiply linked file");
  int fd = openat(source, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW |
                               (S_ISDIR(st->st_mode) ? O_DIRECTORY : 0));
  struct stat opened;
  if (fd < 0 || fstat(fd, &opened))
    err(1, "Open snapshot source");
  if (!unchanged(st, &opened))
    errx(SOURCE_CHANGED, "Snapshot source changed");

  if (S_ISREG(st->st_mode)) {
    if (st->st_size < 0 || (uint64_t)st->st_size > 512ULL * 1024 * 1024 - bytes)
      errx(BYTE_LIMIT, "Snapshot exceeds 512 MiB");
    bytes += (uint64_t)st->st_size;
    if (fclonefileat(fd, target, output, CLONE_NOOWNERCOPY)) {
      if (errno == EXDEV || errno == ENOTSUP)
        err(CLONE_UNAVAILABLE, "Clone snapshot file");
      err(1, "clone snapshot file");
    }
    close(fd);
    return item;
  }

  if (mkdirat(target, output, 0700))
    err(1, "create snapshot directory");
  int dest = openat(target, output, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  DIR *dir = fdopendir(fd);
  if (dest < 0 || !dir)
    err(1, "open snapshot directory");
  for (;;) {
    errno = 0;
    struct dirent *child = readdir(dir);
    if (!child) {
      if (errno)
        err(1, "read snapshot directory");
      break;
    }
    if (!strcmp(child->d_name, ".") || !strcmp(child->d_name, ".."))
      continue;
    struct entry *entry = copy_entry(fd, dest, child->d_name, child->d_name,
                                     depth + 1, volume);
    entry->next = item->children;
    item->children = entry;
  }
  closedir(dir);
  close(dest);
  return item;
}

static void verify(int parent, struct entry *item) {
  struct stat current;
  if (fstatat(parent, item->name, &current, AT_SYMLINK_NOFOLLOW) ||
      !unchanged(&item->metadata, &current))
    errx(SOURCE_CHANGED, "Workspace changed while the snapshot was being copied");
  if (item->children) {
    int fd = openat(parent, item->name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0 || fstat(fd, &current) || !unchanged(&item->metadata, &current))
      errx(SOURCE_CHANGED, "Snapshot directory changed");
    for (struct entry *child = item->children; child; child = child->next)
      verify(fd, child);
    close(fd);
  }
}

static void verify_links(const char *root, const char *directory,
                         const struct entry *children) {
  for (const struct entry *item = children; item; item = item->next) {
    if (!item->children && !S_ISLNK(item->metadata.st_mode))
      continue;
    char pathname[PATH_MAX];
    if ((size_t)snprintf(pathname, sizeof(pathname), "%s/%s", directory,
                         item->name) >= sizeof(pathname))
      errx(PATH_LIMIT, "Snapshot path exceeds the path length limit");
    if (S_ISLNK(item->metadata.st_mode)) {
      char resolved[PATH_MAX];
      size_t length = strlen(root);
      if (!realpath(pathname, resolved) || strncmp(resolved, root, length) ||
          (resolved[length] != '/' && resolved[length] != 0))
        errx(UNRESOLVED_LINK, "Snapshot link does not resolve inside the copied directory");
    } else {
      verify_links(root, pathname, item->children);
    }
  }
}

int main(int argc, char **argv) {
  if (argc != 3)
    errx(1, "Expected the canonical workspace and a private allocation directory");
  struct stat root;
  if (lstat(argv[1], &root) || !S_ISDIR(root.st_mode))
    errx(1, "Expected a workspace directory");
  int dest = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (dest < 0)
    err(1, "open private snapshot allocation");
  struct entry *manifest = copy_entry(AT_FDCWD, dest, argv[1], "workspace", 0, root.st_dev);
  char workspace[PATH_MAX];
  if ((size_t)snprintf(workspace, sizeof(workspace), "%s/workspace", argv[2]) >= sizeof(workspace))
    errx(PATH_LIMIT, "Snapshot allocation path exceeds the path length limit");
  verify_links(workspace, workspace, manifest->children);
  verify(AT_FDCWD, manifest);
  return 0;
}
