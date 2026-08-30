//go:build windows

package deliveryevidence

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

const (
	externalRootMaxPathBytes     = 1024
	externalRootMaxEntries       = 1000
	externalRootMaxDepth         = 10
	winGenericRead               = 0x80000000
	winFileShareRead             = 0x00000001
	winCreateExisting            = 3
	winFileFlagBackupSemantics   = 0x02000000
	winFileFlagOpenReparsePoint  = 0x00200000
	winFileAttributeReparsePoint = 0x00000400
	winFileAttributeDirectory    = 0x00000010
	winFileAttributeSparseFile   = 0x00000200
	winFileIdInfoClass           = 18
)

type ExternalEvidenceRootOptions struct {
	DisjointPaths []string
	CandidateRoot string
	TrustedRoot   string
	GitCommonDir  string
	GitObjectsDir string
	ReviewRoot    string
	TempRoot      string
}

func externalIdentityKey(value string) string { return strings.ToLower(value) }
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
func windowsPathKey(value string) string {
	value = strings.TrimPrefix(value, `\\?\`)
	return strings.ToLower(filepath.Clean(value))
}
func windowsPathInside(parent, child string) bool {
	p, c := windowsPathKey(parent), windowsPathKey(child)
	rel, err := filepath.Rel(p, c)
	return err == nil && (rel == "." || (rel != ".." && !strings.HasPrefix(rel, `..\`) && !filepath.IsAbs(rel)))
}
func windowsUnsafeRootPath(path string) bool {
	if path == "" || len([]byte(path)) > externalRootMaxPathBytes || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) || strings.ContainsAny(path, "\r\n\t") {
		return true
	}
	if strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, `//`) || strings.HasPrefix(path, `\\?\`) || strings.HasPrefix(path, `\\.\`) {
		return true
	}
	reserved := func(segment string) bool {
		upper := strings.ToUpper(strings.SplitN(segment, ".", 2)[0])
		return upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL" || upper == "CLOCK$" || (len(upper) == 4 && (strings.HasPrefix(upper, "COM") || strings.HasPrefix(upper, "LPT")) && upper[3] >= '1' && upper[3] <= '9')
	}
	for _, segment := range strings.FieldsFunc(path, func(r rune) bool { return r == '\\' || r == '/' }) {
		if segment == "" || strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, " ") || reserved(segment) {
			return true
		}
	}
	return false
}
func winHandleInfo(handle syscall.Handle) (syscall.ByHandleFileInformation, error) {
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &info); err != nil {
		return info, err
	}
	return info, nil
}

// winFILE_ID_128 mirrors the Windows FILE_ID_128 contract used by
// GetFileInformationByHandleEx(FileIdInfo). The legacy 64-bit file-index API
// is not sufficient for a cross-volume identity binding.
type winFILE_ID_128 [16]byte
type winFileIDInfo struct {
	VolumeSerialNumber uint64
	FileID             winFILE_ID_128
}

func winFileID128(handle syscall.Handle) (uint64, uint64, uint64, bool) {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel.NewProc("GetFileInformationByHandleEx")
	var value winFileIDInfo
	ret, _, _ := proc.Call(uintptr(handle), uintptr(winFileIdInfoClass), uintptr(unsafe.Pointer(&value)), unsafe.Sizeof(value))
	if ret == 0 {
		return 0, 0, 0, false
	}
	return value.VolumeSerialNumber, binary.LittleEndian.Uint64(value.FileID[0:8]), binary.LittleEndian.Uint64(value.FileID[8:16]), true
}
func boolToUint32(value bool) uint32 {
	if value {
		return 1
	}
	return 0
}
func winIdentityFromHandle(handle syscall.Handle, info syscall.ByHandleFileInformation) externalIdentity {
	low := uint64(0)
	high := uint64(0)
	device := uint64(0)
	hasFile128 := false
	if fileDevice, fileLow, fileHigh, ok := winFileID128(handle); ok {
		device, low, high, hasFile128 = fileDevice, fileLow, fileHigh, true
	}
	reparse := info.FileAttributes&winFileAttributeReparsePoint != 0
	return externalIdentity{Device: device, File: low, FileHigh: high, Links: uint64(info.NumberOfLinks), Size: int64(uint64(info.FileSizeHigh)<<32 | uint64(info.FileSizeLow)), Mode: info.FileAttributes, Modified: int64(info.LastWriteTime.HighDateTime)<<32 | int64(uint32(info.LastWriteTime.LowDateTime)),
		HasDevice: hasFile128, HasFile: hasFile128, HasFile128: hasFile128, HasLinks: true, Type: boolToUint32(info.FileAttributes&winFileAttributeDirectory != 0), Reparse: reparse}
}
func winOpenInfo(path string, directory bool) (syscall.ByHandleFileInformation, error) {
	handle, info, err := winOpen(path, directory)
	if err == nil {
		_ = syscall.CloseHandle(handle)
	}
	return info, err
}
func winOpen(path string, directory bool) (syscall.Handle, syscall.ByHandleFileInformation, error) {
	wide, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, syscall.ByHandleFileInformation{}, err
	}
	flags := uint32(winFileFlagOpenReparsePoint)
	if directory {
		flags |= winFileFlagBackupSemantics
	}
	handle, err := syscall.CreateFile(wide, winGenericRead, winFileShareRead, nil, winCreateExisting, flags, 0)
	if err != nil {
		return 0, syscall.ByHandleFileInformation{}, err
	}
	info, err := winHandleInfo(handle)
	if err != nil {
		_ = syscall.CloseHandle(handle)
		return 0, info, err
	}
	return handle, info, nil
}
func winFinalPath(handle syscall.Handle) (string, error) {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel.NewProc("GetFinalPathNameByHandleW")
	for size := uint32(512); size <= 16*1024; size *= 2 {
		buffer := make([]uint16, size)
		ret, _, callErr := proc.Call(uintptr(handle), uintptr(unsafe.Pointer(&buffer[0])), uintptr(size), 0)
		if ret == 0 {
			return "", callErr
		}
		if ret < uintptr(size-1) {
			return syscall.UTF16ToString(buffer[:ret]), nil
		}
	}
	return "", fmt.Errorf("final handle path exceeds bound")
}
func windowsRejectLexicalAncestors(path string) error {
	current := filepath.Clean(path)
	for {
		info, err := os.Lstat(current)
		if err != nil {
			return &ExternalEvidenceError{Code: "evidence_root_invalid", Err: err}
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return &ExternalEvidenceError{Code: "evidence_root_invalid"}
		}
		handleInfo, err := winOpenInfo(current, true)
		if err != nil || handleInfo.FileAttributes&winFileAttributeReparsePoint != 0 {
			return &ExternalEvidenceError{Code: "evidence_root_invalid", Err: err}
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
}
func windowsCanonicalDirectory(path string) (string, syscall.ByHandleFileInformation, error) {
	if windowsUnsafeRootPath(path) {
		return "", syscall.ByHandleFileInformation{}, &ExternalEvidenceError{Code: "evidence_root_invalid"}
	}
	clean := filepath.Clean(path)
	if path != clean {
		return "", syscall.ByHandleFileInformation{}, &ExternalEvidenceError{Code: "evidence_root_invalid"}
	}
	if err := windowsRejectLexicalAncestors(clean); err != nil {
		return "", syscall.ByHandleFileInformation{}, err
	}
	info, err := os.Lstat(clean)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", syscall.ByHandleFileInformation{}, &ExternalEvidenceError{Code: "evidence_root_invalid", Err: err}
	}
	handle, handleInfo, err := winOpen(clean, true)
	if err != nil {
		return "", handleInfo, &ExternalEvidenceError{Code: "evidence_root_invalid", Err: err}
	}
	defer syscall.CloseHandle(handle)
	if handleInfo.FileAttributes&winFileAttributeReparsePoint != 0 {
		return "", handleInfo, &ExternalEvidenceError{Code: "evidence_root_invalid"}
	}
	final, err := winFinalPath(handle)
	if err != nil || len([]byte(final)) > externalRootMaxPathBytes {
		return "", handleInfo, &ExternalEvidenceError{Code: "evidence_root_invalid", Err: err}
	}
	return final, handleInfo, nil
}
func windowsAncestorChain(root string) ([]externalAncestor, error) {
	chain := make([]externalAncestor, 0, 16)
	current := root
	for {
		handle, info, err := winOpen(current, true)
		if err != nil {
			return nil, &ExternalEvidenceError{Code: "evidence_root_invalid", Err: err}
		}
		identity := winIdentityFromHandle(handle, info)
		_ = syscall.CloseHandle(handle)
		if info.FileAttributes&winFileAttributeReparsePoint != 0 {
			return nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
		}
		if !identity.HasFile128 {
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
func canonicalExcludedPath(path string) (externalExcludedPath, error) {
	canonical, _, err := windowsCanonicalDirectory(path)
	if err != nil {
		return externalExcludedPath{}, err
	}
	ancestors, err := windowsAncestorChain(canonical)
	if err != nil {
		return externalExcludedPath{}, err
	}
	return externalExcludedPath{Path: canonical, Ancestors: ancestors}, nil
}
func OpenExternalEvidenceRoot(path string, options ...any) (*ExternalEvidenceRoot, error) {
	canonical, _, err := windowsCanonicalDirectory(path)
	if err != nil {
		return nil, err
	}
	ancestors, err := windowsAncestorChain(canonical)
	if err != nil {
		return nil, err
	}
	rootHandle, rootInfo, rootErr := winOpen(canonical, true)
	if rootErr != nil {
		return nil, &ExternalEvidenceError{Code: "evidence_root_invalid", Err: rootErr}
	}
	identity := winIdentityFromHandle(rootHandle, rootInfo)
	_ = syscall.CloseHandle(rootHandle)
	if !identity.HasFile128 || !identity.HasDevice {
		return nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
	}
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
		if windowsPathInside(exclusion.Path, canonical) || windowsPathInside(canonical, exclusion.Path) {
			return nil, &ExternalEvidenceError{Code: "evidence_root_invalid"}
		}
		key := windowsPathKey(exclusion.Path)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		exclusions = append(exclusions, exclusion)
	}
	return &ExternalEvidenceRoot{Path: canonical, Identity: identity, Ancestors: ancestors, Exclusions: exclusions, Device: identity.Device}, nil
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
func windowsExternalArtifactInfo(info syscall.ByHandleFileInformation, directory bool, rootDevice uint64) error {
	_ = rootDevice // The authenticated FILE_ID_INFO volume serial is checked from the opened handle.
	if info.FileAttributes&(winFileAttributeReparsePoint|winFileAttributeSparseFile|winFileAttributeDirectory) != 0 || directory || info.NumberOfLinks != 1 {
		return &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	size := uint64(info.FileSizeHigh)<<32 | uint64(info.FileSizeLow)
	if size > uint64(maxAcceptanceV2ArtifactBytes) {
		return &ExternalEvidenceError{Code: "artifact_too_large"}
	}
	return nil
}
func currentExternalAncestors(root *ExternalEvidenceRoot) error {
	for _, ancestor := range root.Ancestors {
		handle, info, err := winOpen(ancestor.Path, true)
		if err != nil {
			return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
		}
		identity := winIdentityFromHandle(handle, info)
		_ = syscall.CloseHandle(handle)
		if info.FileAttributes&winFileAttributeReparsePoint != 0 || !identity.HasFile128 || !externalAncestorIdentitiesEqual(ancestor.Identity, identity) {
			return &ExternalEvidenceError{Code: "evidence_identity_changed"}
		}
	}
	handle, info, err := winOpen(root.Path, true)
	if err != nil {
		return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
	}
	identity := winIdentityFromHandle(handle, info)
	_ = syscall.CloseHandle(handle)
	if !identity.HasFile128 || !externalAncestorIdentitiesEqual(root.Identity, identity) {
		return &ExternalEvidenceError{Code: "evidence_identity_changed"}
	}
	for _, exclusion := range root.Exclusions {
		for _, ancestor := range exclusion.Ancestors {
			handle, info, checkErr := winOpen(ancestor.Path, true)
			if checkErr != nil {
				return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: checkErr}
			}
			identity := winIdentityFromHandle(handle, info)
			_ = syscall.CloseHandle(handle)
			if info.FileAttributes&winFileAttributeReparsePoint != 0 || !identity.HasFile128 || !externalAncestorIdentitiesEqual(ancestor.Identity, identity) {
				return &ExternalEvidenceError{Code: "evidence_identity_changed"}
			}
		}
	}
	return nil
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
	beforeDirectoryPaths := []string{root.Path}
	beforeDirectoryPath := root.Path
	for _, segment := range segments[:len(segments)-1] {
		beforeDirectoryPath = filepath.Join(beforeDirectoryPath, segment)
		handle, info, openErr := winOpen(beforeDirectoryPath, true)
		if openErr != nil {
			return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: openErr}
		}
		identity := winIdentityFromHandle(handle, info)
		finalPath, finalErr := winFinalPath(handle)
		_ = syscall.CloseHandle(handle)
		if finalErr != nil || info.FileAttributes&winFileAttributeReparsePoint != 0 || !identity.HasFile128 || identity.Device != root.Device || windowsPathKey(finalPath) != windowsPathKey(beforeDirectoryPath) {
			return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: finalErr}
		}
		beforeDirectoryIdentities = append(beforeDirectoryIdentities, identity)
		beforeDirectoryPaths = append(beforeDirectoryPaths, beforeDirectoryPath)
	}
	full := filepath.Join(append([]string{root.Path}, segments...)...)
	beforeInfo, err := os.Lstat(full)
	if err != nil || beforeInfo.Mode()&os.ModeSymlink != 0 {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_path_invalid", Err: err}
	}
	handle, handleInfo, err := winOpen(full, false)
	if err != nil {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
	}
	file := os.NewFile(uintptr(handle), full)
	if file == nil {
		_ = syscall.CloseHandle(handle)
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed"}
	}
	defer file.Close()
	if err := windowsExternalArtifactInfo(handleInfo, false, root.Device); err != nil {
		return nil, externalIdentity{}, err
	}
	beforeIdentity := winIdentityFromHandle(handle, handleInfo)
	if !beforeIdentity.HasFile128 || !beforeIdentity.HasDevice || beforeIdentity.Device != root.Device {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed"}
	}
	final, finalErr := winFinalPath(handle)
	if finalErr != nil || windowsPathKey(final) != windowsPathKey(full) || !windowsPathInside(root.Path, final) {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: finalErr}
	}
	data, readErr := io.ReadAll(io.LimitReader(file, maximum+1))
	if readErr != nil {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: readErr}
	}
	if int64(len(data)) != beforeIdentity.Size || int64(len(data)) > maximum {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed"}
	}
	afterInfo, statErr := winHandleInfo(handle)
	afterIdentity := winIdentityFromHandle(handle, afterInfo)
	if statErr != nil || !externalIdentitiesEqual(beforeIdentity, afterIdentity) {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: statErr}
	}
	pathInfo, pathErr := os.Lstat(full)
	pathHandle, pathHandleInfo, pathOpenErr := winOpen(full, false)
	var pathIdentity externalIdentity
	if pathOpenErr == nil {
		pathIdentity = winIdentityFromHandle(pathHandle, pathHandleInfo)
		_ = syscall.CloseHandle(pathHandle)
	}
	pathIdentityMatches := pathOpenErr == nil && externalIdentitiesEqual(beforeIdentity, pathIdentity)
	if pathErr != nil || pathInfo.Mode()&os.ModeSymlink != 0 || pathInfo.Size() != beforeInfo.Size() || !pathIdentityMatches {
		return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: pathErr}
	}
	for index, expected := range beforeDirectoryIdentities {
		path := beforeDirectoryPaths[index]
		handle, info, openErr := winOpen(path, true)
		if openErr != nil {
			return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: openErr}
		}
		identity := winIdentityFromHandle(handle, info)
		finalPath, finalErr := winFinalPath(handle)
		_ = syscall.CloseHandle(handle)
		if finalErr != nil || info.FileAttributes&winFileAttributeReparsePoint != 0 || !identity.HasFile128 || !externalAncestorIdentitiesEqual(expected, identity) || windowsPathKey(finalPath) != windowsPathKey(path) {
			return nil, externalIdentity{}, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: finalErr}
		}
	}
	if err := currentExternalAncestors(root); err != nil {
		return nil, externalIdentity{}, err
	}
	return data, afterIdentity, nil
}
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
func windowsWalkExternalEvidence(root *ExternalEvidenceRoot, directory, relativePath string, depth int, entries *[]ExternalEvidenceInventoryEntry, totalBytes *int64) error {
	if depth > externalRootMaxDepth {
		return &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	if err := currentExternalAncestors(root); err != nil {
		return err
	}
	directoryHandle, directoryInfo, err := winOpen(directory, true)
	if err != nil {
		return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
	}
	directoryFile := os.NewFile(uintptr(directoryHandle), directory)
	if directoryFile == nil {
		_ = syscall.CloseHandle(directoryHandle)
		return &ExternalEvidenceError{Code: "evidence_identity_changed"}
	}
	defer directoryFile.Close()
	if directoryInfo.FileAttributes&winFileAttributeReparsePoint != 0 {
		return &ExternalEvidenceError{Code: "evidence_path_invalid"}
	}
	directoryIdentity := winIdentityFromHandle(directoryHandle, directoryInfo)
	final, err := winFinalPath(directoryHandle)
	if err != nil || windowsPathKey(final) != windowsPathKey(directory) || !windowsPathInside(root.Path, final) {
		return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
	}
	items, err := collectExternalEntries(func() ([]os.FileInfo, error) { return directoryFile.Readdir(1) })
	if err != nil {
		return err
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name() < items[j].Name() })
	for _, item := range items {
		if len(*entries) >= externalRootMaxEntries {
			return &ExternalEvidenceError{Code: "artifact_too_large"}
		}
		if relativePath == "" && item.Name() == AcceptanceV2InventoryReportName {
			continue
		}
		rel := item.Name()
		if relativePath != "" {
			rel = relativePath + "/" + item.Name()
		}
		if !validV2ArtifactPath(rel) || strings.Count(rel, "/")+1 > externalRootMaxDepth {
			return &ExternalEvidenceError{Code: "evidence_path_invalid"}
		}
		full := filepath.Join(directory, item.Name())
		handle, handleInfo, err := winOpen(full, item.IsDir())
		if err != nil {
			return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
		}
		childIdentity := winIdentityFromHandle(handle, handleInfo)
		childFinal, finalErr := winFinalPath(handle)
		_ = syscall.CloseHandle(handle)
		if finalErr != nil || !childIdentity.HasFile128 || windowsPathKey(childFinal) != windowsPathKey(full) || !windowsPathInside(root.Path, childFinal) {
			return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: finalErr}
		}
		if handleInfo.FileAttributes&winFileAttributeReparsePoint != 0 {
			return &ExternalEvidenceError{Code: "evidence_path_invalid"}
		}
		if item.IsDir() {
			if childIdentity.Device != root.Device {
				return &ExternalEvidenceError{Code: "evidence_path_invalid"}
			}
			*entries = append(*entries, ExternalEvidenceInventoryEntry{Path: rel, Type: "directory", Identity: externalIdentityText(childIdentity), SHA256: DigestOutput(nil)})
			if err := windowsWalkExternalEvidence(root, full, rel, depth+1, entries, totalBytes); err != nil {
				return err
			}
			continue
		}
		if err := windowsExternalArtifactInfo(handleInfo, false, root.Device); err != nil {
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
	finalInfo, statErr := winHandleInfo(syscall.Handle(directoryFile.Fd()))
	if statErr != nil || !externalAncestorIdentitiesEqual(directoryIdentity, winIdentityFromHandle(syscall.Handle(directoryFile.Fd()), finalInfo)) {
		return &ExternalEvidenceError{Code: "evidence_identity_changed", Err: statErr}
	}
	if err := currentExternalAncestors(root); err != nil {
		return err
	}
	return nil
}
func InventoryExternalEvidenceRoot(root *ExternalEvidenceRoot) (ExternalEvidenceInventory, error) {
	if root == nil {
		return ExternalEvidenceInventory{}, &ExternalEvidenceError{Code: "evidence_root_invalid"}
	}
	if err := currentExternalAncestors(root); err != nil {
		return ExternalEvidenceInventory{}, err
	}
	entries := make([]ExternalEvidenceInventoryEntry, 0)
	totalBytes := int64(0)
	if err := windowsWalkExternalEvidence(root, root.Path, "", 0, &entries, &totalBytes); err != nil {
		return ExternalEvidenceInventory{}, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	if err := currentExternalAncestors(root); err != nil {
		return ExternalEvidenceInventory{}, err
	}
	return ExternalEvidenceInventory{Entries: entries}, nil
}
func externalInventoryEqual(left, right ExternalEvidenceInventory) bool {
	return bytes.Equal(canonicalJSON(left), canonicalJSON(right))
}
