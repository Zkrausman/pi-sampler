//go:build !windows

package deliveryevidence

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

const (
	externalRootMaxPathBytes = 1024
	externalRootMaxEntries   = 1000
	externalRootMaxDepth     = 10
)

func externalIdentityKey(value string) string { return value }

func externalRootOptions(values []any) []string {
	paths := make([]string, 0, len(values))
	for _, value := range values {
		switch typed := value.(type) {
		case string:
			paths = append(paths, typed)
		case []string:
			paths = append(paths, typed...)
		case ExternalEvidenceRootOptions:
			paths = append(paths, typed.DisjointPaths...)
			paths = append(paths, typed.CandidateRoot, typed.TrustedRoot, typed.GitCommonDir, typed.GitObjectsDir, typed.ReviewRoot, typed.TempRoot)
		case *ExternalEvidenceRootOptions:
			if typed != nil {
				paths = append(paths, typed.DisjointPaths...)
				paths = append(paths, typed.CandidateRoot, typed.TrustedRoot, typed.GitCommonDir, typed.GitObjectsDir, typed.ReviewRoot, typed.TempRoot)
			}
		}
	}
	return paths
}

// ExternalEvidenceRootOptions identifies repository and temporary roots that
// must remain disjoint from the operator-owned evidence root.
type ExternalEvidenceRootOptions struct {
	DisjointPaths []string
	CandidateRoot string
	TrustedRoot   string
	GitCommonDir  string
	GitObjectsDir string
	ReviewRoot    string
	TempRoot      string
}

func posixPathInside(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && (rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)))
}

func rejectLexicalAncestors(path string) error {
	current := filepath.Clean(path)
	for {
		info, err := os.Lstat(current)
		if err != nil {
			return &ExternalEvidenceError{Code: "evidence_root_invalid", Err: err}
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return &ExternalEvidenceError{Code: "evidence_root_invalid"}
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
}

func canonicalExistingDirectory(path string) (string, os.FileInfo, error) {
	if path == "" || len([]byte(path)) > externalRootMaxPathBytes || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) || strings.ContainsAny(path, "\r\n\t") {
		return "", nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
	}
	clean := filepath.Clean(path)
	if path != clean || strings.Contains(path, "\\") || strings.Contains(path, ":") {
		return "", nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
	}
	for _, part := range strings.Split(strings.TrimPrefix(clean, string(filepath.Separator)), string(filepath.Separator)) {
		upper := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		reserved := upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL" || upper == "CLOCK$" || (len(upper) == 4 && (strings.HasPrefix(upper, "COM") || strings.HasPrefix(upper, "LPT")) && upper[3] >= '1' && upper[3] <= '9')
		if part == "" || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || reserved {
			return "", nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
		}
	}
	if err := rejectLexicalAncestors(clean); err != nil {
		return "", nil, err
	}
	info, err := os.Lstat(clean)
	if err != nil {
		return "", nil, &ExternalEvidenceError{Code: "evidence_root_invalid", Err: err}
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
	}
	canonical, err := filepath.EvalSymlinks(clean)
	if err != nil || canonical != clean {
		return "", nil, &ExternalEvidenceError{Code: "evidence_root_invalid", Err: err}
	}
	return canonical, info, nil
}

func externalAncestorChain(root string) ([]externalAncestor, error) {
	chain := make([]externalAncestor, 0, 16)
	current := root
	for {
		info, err := os.Lstat(current)
		if err != nil {
			return nil, &ExternalEvidenceError{Code: "evidence_root_invalid", Err: err}
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
		}
		identity := externalIdentityFromInfo(info)
		if !identity.HasDevice || !identity.HasFile {
			return nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
		}
		chain = append(chain, externalAncestor{Path: current, Identity: identity})
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	for left, right := 0, len(chain)-1; left < right; left, right = left+1, right-1 {
		chain[left], chain[right] = chain[right], chain[left]
	}
	return chain, nil
}

// OpenExternalEvidenceRoot opens and authenticates an absolute, canonical,
// operator-owned directory. Additional arguments are accepted as strings, a
// []string, or ExternalEvidenceRootOptions to keep the platform seam useful to
// both the controller and package-level adversarial tests.
func canonicalExcludedPath(path string) (externalExcludedPath, error) {
	canonical, _, err := canonicalExistingDirectory(path)
	if err != nil {
		return externalExcludedPath{}, err
	}
	ancestors, err := externalAncestorChain(canonical)
	if err != nil {
		return externalExcludedPath{}, err
	}
	return externalExcludedPath{Path: canonical, Ancestors: ancestors}, nil
}

func OpenExternalEvidenceRoot(path string, options ...any) (*ExternalEvidenceRoot, error) {
	canonical, info, err := canonicalExistingDirectory(path)
	if err != nil {
		return nil, err
	}
	ancestors, err := externalAncestorChain(canonical)
	if err != nil {
		return nil, err
	}
	rootIdentity := externalIdentityFromInfo(info)
	exclusions := make([]externalExcludedPath, 0)
	seen := make(map[string]struct{})
	for _, other := range externalRootOptions(options) {
		if other == "" {
			continue
		}
		exclusion, exclusionErr := canonicalExcludedPath(other)
		if exclusionErr != nil {
			return nil, &ExternalEvidenceError{Code: "evidence_root_invalid", Err: exclusionErr}
		}
		if posixPathInside(exclusion.Path, canonical) || posixPathInside(canonical, exclusion.Path) {
			return nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
		}
		if _, duplicate := seen[exclusion.Path]; duplicate {
			continue
		}
		seen[exclusion.Path] = struct{}{}
		exclusions = append(exclusions, exclusion)
	}
	return &ExternalEvidenceRoot{Path: canonical, Identity: rootIdentity, Ancestors: ancestors, Exclusions: exclusions, Device: rootIdentity.Device}, nil
}

func externalArtifactPathSegments(path string) ([]string, error) {
	if !validV2ArtifactPath(path) {
		return nil, &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	parts := strings.Split(path, "/")
	if len(parts) > externalRootMaxDepth {
		return nil, &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	for _, part := range parts {
		if len([]byte(part)) > 255 {
			return nil, &ExternalEvidenceError{Code: "evidence_path_invalid"}
		}
	}
	return parts, nil
}

func posixOpenDirectory(path string) (*os.File, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

func posixOpenArtifact(root string, segments []string) (*os.File, []*os.File, error) {
	parent, err := posixOpenDirectory(root)
	if err != nil {
		return nil, nil, err
	}
	directories := []*os.File{parent}
	closeAll := func() {
		for index := len(directories) - 1; index >= 0; index-- {
			_ = directories[index].Close()
		}
	}
	for _, segment := range segments[:len(segments)-1] {
		fd, openErr := syscall.Openat(int(parent.Fd()), segment, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if openErr != nil {
			closeAll()
			return nil, nil, openErr
		}
		child := os.NewFile(uintptr(fd), filepath.Join(parent.Name(), segment))
		directories = append(directories, child)
		parent = child
	}
	fd, openErr := syscall.Openat(int(parent.Fd()), segments[len(segments)-1], syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if openErr != nil {
		closeAll()
		return nil, nil, openErr
	}
	return os.NewFile(uintptr(fd), segments[len(segments)-1]), directories, nil
}

func closeExternalDirectories(directories []*os.File) {
	for index := len(directories) - 1; index >= 0; index-- {
		_ = directories[index].Close()
	}
}

func externalArtifactInfo(info os.FileInfo, rootDevice uint64) error {
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	identity := externalIdentityFromInfo(info)
	if !identity.HasDevice || !identity.HasFile || !identity.HasLinks || identity.Links != 1 || identity.Device != rootDevice {
		return &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	if info.Size() < 0 || info.Size() > maxAcceptanceV2ArtifactBytes {
		return &ExternalEvidenceError{Code: "artifact_too_large"}
	}
	if identity.HasBlocks && uint64(info.Size()) > identity.Blocks*512 {
		return &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	return nil
}

func currentExternalAncestors(root *ExternalEvidenceRoot) error {
	for _, ancestor := range root.Ancestors {
		info, err := os.Lstat(ancestor.Path)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || !externalAncestorIdentitiesEqual(ancestor.Identity, externalIdentityFromInfo(info)) {
			return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
		}
	}
	rootInfo, err := os.Lstat(root.Path)
	if err != nil || !externalAncestorIdentitiesEqual(root.Identity, externalIdentityFromInfo(rootInfo)) {
		return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
	}
	for _, exclusion := range root.Exclusions {
		for _, ancestor := range exclusion.Ancestors {
			info, checkErr := os.Lstat(ancestor.Path)
			if checkErr != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || !externalAncestorIdentitiesEqual(ancestor.Identity, externalIdentityFromInfo(info)) {
				return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: checkErr}
			}
		}
	}
	return nil
}

func expectedDirectoryPath(root string, segments []string, index int) string {
	if index == 0 {
		return root
	}
	return filepath.Join(append([]string{root}, segments[:index]...)...)
}

func readExternalPath(root *ExternalEvidenceRoot, path string, maximum int64) ([]byte, externalIdentity, error) {
	segments, err := externalArtifactPathSegments(path)
	if err != nil {
		return nil, externalIdentity{}, err
	}
	if err := currentExternalAncestors(root); err != nil {
		return nil, externalIdentity{}, err
	}
	beforeDirectoryIdentities := []externalIdentity{root.Identity}
	beforeDirectoryPath := root.Path
	for _, segment := range segments[:len(segments)-1] {
		beforeDirectoryPath = filepath.Join(beforeDirectoryPath, segment)
		info, infoErr := os.Lstat(beforeDirectoryPath)
		if infoErr != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: infoErr}
		}
		identity := externalIdentityFromInfo(info)
		if !identity.HasDevice || !identity.HasFile || identity.Device != root.Device {
			return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed"}
		}
		beforeDirectoryIdentities = append(beforeDirectoryIdentities, identity)
	}
	beforePath := filepath.Join(append([]string{root.Path}, segments...)...)
	beforeInfo, err := os.Lstat(beforePath)
	if err != nil {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_path_invalid", Err: err}
	}
	if err := externalArtifactInfo(beforeInfo, root.Device); err != nil {
		return nil, externalIdentity{}, err
	}
	file, directories, err := posixOpenArtifact(root.Path, segments)
	if err != nil {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
	}
	defer closeExternalDirectories(directories)
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
	}
	if err := externalArtifactInfo(openedInfo, root.Device); err != nil {
		return nil, externalIdentity{}, err
	}
	if !externalIdentitiesEqual(externalIdentityFromInfo(beforeInfo), externalIdentityFromInfo(openedInfo)) {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed"}
	}
	directoryIdentities := make([]externalIdentity, len(directories))
	for index, directory := range directories {
		info, statErr := directory.Stat()
		if statErr != nil {
			return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: statErr}
		}
		directoryIdentities[index] = externalIdentityFromInfo(info)
	}
	if len(directoryIdentities) != len(beforeDirectoryIdentities) || len(directoryIdentities) == 0 || !externalAncestorIdentitiesEqual(root.Identity, directoryIdentities[0]) {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed"}
	}
	for index := range beforeDirectoryIdentities {
		if !externalAncestorIdentitiesEqual(beforeDirectoryIdentities[index], directoryIdentities[index]) {
			return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed"}
		}
	}
	if openedInfo.Size() > maximum {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "artifact_too_large"}
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maximum+1))
	if readErr != nil {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: readErr}
	}
	if int64(len(data)) != openedInfo.Size() || int64(len(data)) > maximum {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed"}
	}
	afterInfo, statErr := file.Stat()
	if statErr != nil || !externalIdentitiesEqual(externalIdentityFromInfo(openedInfo), externalIdentityFromInfo(afterInfo)) {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: statErr}
	}
	for index, directory := range directories {
		info, statErr := directory.Stat()
		if statErr != nil || !externalAncestorIdentitiesEqual(directoryIdentities[index], externalIdentityFromInfo(info)) {
			return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: statErr}
		}
	}
	for index, expected := range beforeDirectoryIdentities {
		currentPath := expectedDirectoryPath(root.Path, segments, index)
		info, statErr := os.Lstat(currentPath)
		if statErr != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || !externalAncestorIdentitiesEqual(expected, externalIdentityFromInfo(info)) {
			return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: statErr}
		}
	}
	pathInfo, pathErr := os.Lstat(beforePath)
	if pathErr != nil || pathInfo.Mode()&os.ModeSymlink != 0 || !externalIdentitiesEqual(externalIdentityFromInfo(beforeInfo), externalIdentityFromInfo(pathInfo)) {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: pathErr}
	}
	if err := currentExternalAncestors(root); err != nil {
		return nil, externalIdentity{}, err
	}
	return data, externalIdentityFromInfo(afterInfo), nil
}

// ReadVerifiedArtifact maps an already-validated portable artifact path to the
// canonical evidence root and performs an identity-bound, bounded read. It
// never searches, normalizes, or follows a caller-selected fallback path.
func ReadVerifiedArtifact(root *ExternalEvidenceRoot, value any, extras ...any) ([]byte, error) {
	artifact, ok := normalizeExternalArtifact(value, extras)
	if !ok {
		return nil, &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	if root == nil {
		return nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
	}
	if !validV2ArtifactPath(artifact.Path) || artifact.Bytes < 0 || artifact.Bytes > maxAcceptanceV2ArtifactBytes || !validV2Digest(artifact.SHA256) {
		return nil, &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	data, _, err := readExternalPath(root, artifact.Path, maxAcceptanceV2ArtifactBytes)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != artifact.Bytes {
		return nil, &ExternalEvidenceError{Code: "artifact_digest_mismatch"}
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != artifact.SHA256 {
		return nil, &ExternalEvidenceError{Code: "artifact_digest_mismatch"}
	}
	return data, nil
}

func walkExternalEvidence(root *ExternalEvidenceRoot, directory, relativePath string, depth int, entries *[]ExternalEvidenceInventoryEntry, totalBytes *int64) error {
	if depth > externalRootMaxDepth {
		return &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	if err := currentExternalAncestors(root); err != nil {
		return err
	}
	directoryHandle, err := posixOpenDirectory(directory)
	if err != nil {
		return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
	}
	defer directoryHandle.Close()
	beforeDirectory, err := directoryHandle.Stat()
	if err != nil {
		return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
	}
	items := make([]os.FileInfo, 0, externalRootMaxEntries)
	for {
		batch, readErr := directoryHandle.Readdir(1)
		if len(batch) > 0 {
			if len(items)+len(batch) > externalRootMaxEntries {
				return &ExternalEvidenceError{Code: "artifact_too_large"}
			}
			items = append(items, batch...)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: readErr}
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name() < items[j].Name() })
	for _, info := range items {
		if len(*entries) >= externalRootMaxEntries {
			return &ExternalEvidenceError{Code: "artifact_too_large"}
		}
		name := info.Name()
		rel := name
		if relativePath == "" && name == acceptanceV2InventoryReportName {
			continue
		}
		if relativePath != "" {
			rel = relativePath + "/" + name
		}
		if !validV2ArtifactPath(rel) || strings.Count(rel, "/")+1 > externalRootMaxDepth {
			return &ExternalEvidenceError{Code: "evidence_path_invalid"}
		}
		full := filepath.Join(directory, name)
		if info.Mode()&os.ModeSymlink != 0 {
			return &ExternalEvidenceError{Code: "evidence_path_invalid"}
		}
		if info.IsDir() {
			identity := externalIdentityFromInfo(info)
			if !identity.HasDevice || !identity.HasFile || identity.Device != root.Device {
				return &ExternalEvidenceError{Code: "evidence_path_invalid"}
			}
			*entries = append(*entries, ExternalEvidenceInventoryEntry{Path: rel, Type: "directory", Identity: externalIdentityText(identity), SHA256: DigestOutput(nil)})
			if err := walkExternalEvidence(root, full, rel, depth+1, entries, totalBytes); err != nil {
				return err
			}
			continue
		}
		if err := externalArtifactInfo(info, root.Device); err != nil {
			return err
		}
		data, identity, err := readExternalPath(root, rel, maxAcceptanceV2ArtifactBytes)
		if err != nil {
			return err
		}
		*totalBytes += int64(len(data))
		if *totalBytes > maxAcceptanceV2MatrixBytes {
			return &ExternalEvidenceError{Code: "artifact_too_large"}
		}
		hash := sha256.Sum256(data)
		*entries = append(*entries, ExternalEvidenceInventoryEntry{Path: rel, Type: "file", Bytes: int64(len(data)), Identity: externalIdentityText(identity), SHA256: hex.EncodeToString(hash[:])})
	}
	afterDirectory, statErr := directoryHandle.Stat()
	if statErr != nil || !externalAncestorIdentitiesEqual(externalIdentityFromInfo(beforeDirectory), externalIdentityFromInfo(afterDirectory)) {
		return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: statErr}
	}
	if err := currentExternalAncestors(root); err != nil {
		return err
	}
	return nil
}

// InventoryExternalEvidenceRoot returns the sorted identity-and-content
// inventory used to detect races or post-read mutations. The caller should
// capture it before and after evaluating all artifacts and compare both the
// entries and inventoryDigest values.
func InventoryExternalEvidenceRoot(root *ExternalEvidenceRoot) (ExternalEvidenceInventory, error) {
	if root == nil {
		return ExternalEvidenceInventory{}, &ExternalEvidenceError{Code: "evidence_root_invalid"}
	}
	if err := currentExternalAncestors(root); err != nil {
		return ExternalEvidenceInventory{}, err
	}
	entries := make([]ExternalEvidenceInventoryEntry, 0)
	totalBytes := int64(0)
	if err := walkExternalEvidence(root, root.Path, "", 0, &entries, &totalBytes); err != nil {
		return ExternalEvidenceInventory{}, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	if err := currentExternalAncestors(root); err != nil {
		return ExternalEvidenceInventory{}, err
	}
	return ExternalEvidenceInventory{Entries: entries}, nil
}

func externalInventoryEqual(left, right ExternalEvidenceInventory) bool {
	return bytes.Equal(inventoryJSON(left), inventoryJSON(right))
}
