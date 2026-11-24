package runner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVectorFormat(t *testing.T) {
	dir := VectorsDir()
	files, err := LoadVectorFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, f := range files {
		data, err := os.ReadFile(filepath.Join(dir, f.File))
		if err != nil {
			t.Fatal(err)
		}
		if p := ValidateFile(f.File, data); len(p) > 0 {
			t.Errorf("%s does not match vector.schema.json:\n  %s", f.File, strings.Join(p, "\n  "))
		}
		for _, v := range f.Vectors {
			if names[v.Name] {
				t.Errorf("duplicate vector name %s", v.Name)
			}
			names[v.Name] = true
		}
	}
	if len(names) < 40 {
		t.Fatalf("expected at least 40 vectors, found %d", len(names))
	}
}

func TestConformance(t *testing.T) {
	files, err := LoadVectorFiles(VectorsDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, fw := range Frameworks {
		passed, total := 0, 0
		t.Run(strings.ReplaceAll(fw, "/", ""), func(t *testing.T) {
			for _, f := range files {
				for i := range f.Vectors {
					v := &f.Vectors[i]
					total++
					t.Run(f.Category+"/"+v.Name, func(t *testing.T) {
						problems, err := RunVector(v, fw)
						if err != nil {
							t.Fatalf("%s (%s): %v", v.Name, fw, err)
						}
						if len(problems) > 0 {
							t.Fatalf("%s (%s): %s\n  %s", v.Name, fw, v.Description, strings.Join(problems, "\n  "))
						}
						passed++
					})
				}
			}
		})
		t.Logf("%s: %d/%d vectors pass", fw, passed, total)
	}
}
